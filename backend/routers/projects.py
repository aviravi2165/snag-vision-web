from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Response
from sqlalchemy.orm import Session
from models import get_db
from models.database import (
    Project, Floor, Unit, Room, Spot, UserRole,
    Activity, ActivityMapping, UnmappedComponent, UnitActivityProgress, ActivityExcelFile,
)
from schemas.models import (
    ProjectCreate, ProjectOut, FloorCreate, FloorOut,
    UnitCreate, RoomCreate, RoomOut, SpotCreate, SpotOut,
    ActivityPlanIn, ActivityItem, UnitMapIn, ActivityMappingIn,
)
from services.progress_service import build_dashboard
from services.gcs_service import upload_media, download_media
from services.excel_service import parse_activity_excel, match_unit_columns
from services.mapping_service import (
    generate_ai_mapping, unit_activity_matrix_as_of, analysis_dates_for_project,
    progress_series,
)
from services.activity_catalog import STANDARD_ACTIVITIES, refresh_standard_classification
from routers.auth import get_current_user, require_role
from typing import List

# Any logged-in user (site_supervisor/project_manager/admin/client) can use
# this router today — the web frontend has no role-specific UI yet, so
# restricting by role here would silently break whichever role's account
# happens to be testing with. Individual destructive/admin-only endpoints
# (e.g. delete_project below) opt into a stricter role check explicitly.
router = APIRouter(prefix="/projects", tags=["projects"], dependencies=[Depends(get_current_user)])


# ── Projects ─────────────────────────────────────────────────────────────────

@router.post("", response_model=ProjectOut, status_code=201)
def create_project(data: ProjectCreate, db: Session = Depends(get_db)):
    p = Project(**data.model_dump())
    db.add(p)
    db.commit()
    db.refresh(p)
    return p


@router.get("", response_model=List[ProjectOut])
def list_projects(db: Session = Depends(get_db)):
    return db.query(Project).all()


@router.get("/{project_id}", response_model=ProjectOut)
def get_project(project_id: str, db: Session = Depends(get_db)):
    p = db.query(Project).get(project_id)
    if not p:
        raise HTTPException(404, "Project not found")
    return p


@router.delete("/{project_id}", status_code=204)
def delete_project(
    project_id: str,
    db: Session = Depends(get_db),
    user=Depends(require_role(UserRole.admin)),
):
    p = db.query(Project).get(project_id)
    if not p:
        raise HTTPException(404, "Project not found")
    db.delete(p)
    db.commit()


@router.get("/{project_id}/dashboard")
def get_dashboard(project_id: str, db: Session = Depends(get_db)):
    return build_dashboard(project_id, db)


# ── Activity Plan — now backed by the Activity table, driven by the uploaded
# Activity Excel (routes further below); manual add/edit stays available as a
# convenience for ad-hoc changes without a spreadsheet. ─────────────────────

def _project_units(project_id: str, db: Session) -> List[Unit]:
    """Every Unit in a project — the Activity Excel's "Room" grain (e.g.
    "A-101"). Not the `Room` model (Living/Bathroom Areas within a Unit) —
    those stay Floor View's concern."""
    units: List[Unit] = []
    for f in db.query(Floor).filter(Floor.project_id == project_id).all():
        units.extend(f.units)
    return units


def _ensure_activities_from_legacy_plan(project: Project, db: Session):
    """One-time lazy migration: a project with the old JSON activity_plan but
    no Activity rows yet gets them copied in, so already-configured projects
    don't need re-setup."""
    if db.query(Activity).filter(Activity.project_id == project.id).count() > 0:
        return
    if not project.activity_plan:
        return
    for i, item in enumerate(project.activity_plan):
        if isinstance(item, str):
            name, target_date = item, None
        else:
            name, target_date = item.get("name"), item.get("target_date")
        if not name:
            continue
        db.add(Activity(
            project_id=project.id, name=name, sort_order=i,
            end_date=datetime.fromisoformat(target_date) if target_date else None,
        ))
    db.commit()


def _activity_out(a: Activity) -> ActivityItem:
    return ActivityItem(
        id=a.id, name=a.name,
        start_date=a.start_date.date().isoformat() if a.start_date else None,
        target_date=a.end_date.date().isoformat() if a.end_date else None,
    )


@router.get("/{project_id}/activities", response_model=List[ActivityItem])
def get_activities(project_id: str, db: Session = Depends(get_db)):
    p = db.query(Project).get(project_id)
    if not p:
        raise HTTPException(404, "Project not found")
    _ensure_activities_from_legacy_plan(p, db)
    rows = (
        db.query(Activity)
        .filter(Activity.project_id == project_id)
        .order_by(Activity.sort_order)
        .all()
    )
    return [_activity_out(a) for a in rows]


@router.put("/{project_id}/activities", response_model=List[ActivityItem])
def set_activities(project_id: str, data: ActivityPlanIn, db: Session = Depends(get_db)):
    p = db.query(Project).get(project_id)
    if not p:
        raise HTTPException(404, "Project not found")
    # ORM delete (not a bulk query.delete()) so ActivityMapping/UnitActivityProgress
    # rows for the replaced activities cascade properly instead of dangling.
    for a in db.query(Activity).filter(Activity.project_id == project_id).all():
        db.delete(a)
    db.flush()
    for i, item in enumerate(data.activities):
        db.add(Activity(
            project_id=project_id, name=item.name, sort_order=i,
            end_date=datetime.fromisoformat(item.target_date) if item.target_date else None,
        ))
    p.activity_plan = None  # legacy JSON is no longer authoritative once Activity rows exist
    db.commit()
    return get_activities(project_id, db)


@router.post("/{project_id}/activities/standard")
async def refresh_standard_classification_endpoint(project_id: str, db: Session = Depends(get_db)):
    """Extend the GLOBAL standard 12-category classifier with every component
    key Gemini has actually observed in this project's photos. Does NOT touch
    the project's own Activity plan — that stays the Activity-Excel BoQ view
    the Executive dashboard reads. Floor View / AI Analysis render through
    this global classifier (services/activity_catalog.py), so new photos with
    new component keys just need this call once. Re-runnable and idempotent
    (unknown keys only get added)."""
    p = db.query(Project).get(project_id)
    if not p:
        raise HTTPException(404, "Project not found")

    result = await refresh_standard_classification(db)

    return {
        "categories": STANDARD_ACTIVITIES,
        "total_categories": len(STANDARD_ACTIVITIES),
        **result,
    }


# ── Activity Excel (master progress sheet) ───────────────────────────────────

@router.post("/{project_id}/activity-excel")
async def upload_activity_excel(project_id: str, file: UploadFile = File(...), db: Session = Depends(get_db)):
    p = db.query(Project).get(project_id)
    if not p:
        raise HTTPException(404, "Project not found")

    contents = await file.read()
    parsed = parse_activity_excel(contents)
    if not parsed.activities:
        raise HTTPException(400, "Couldn't find any activity rows in this file")

    # Project-level file (not room-keyed) — sentinel room_id for the storage path scheme.
    file_url, file_path = await upload_media(
        contents, file.filename or "activity_plan.xlsx", project_id, "_activity_excel"
    )

    for a in db.query(Activity).filter(Activity.project_id == project_id).all():
        db.delete(a)
    db.flush()

    activities: List[Activity] = []
    for i, pa in enumerate(parsed.activities):
        a = Activity(project_id=project_id, name=pa.name, start_date=pa.start_date,
                      end_date=pa.end_date, sort_order=i)
        db.add(a)
        activities.append(a)
    db.flush()

    matched, unmatched = match_unit_columns(parsed.unit_columns, _project_units(project_id, db))

    excel_file = db.query(ActivityExcelFile).filter(ActivityExcelFile.project_id == project_id).first()
    if not excel_file:
        excel_file = ActivityExcelFile(project_id=project_id)
        db.add(excel_file)
    excel_file.file_url = file_url
    excel_file.file_path = file_path
    excel_file.original_filename = file.filename
    excel_file.sheet_name = parsed.sheet_name
    excel_file.activity_col = parsed.activity_col
    excel_file.start_date_col = parsed.start_date_col
    excel_file.end_date_col = parsed.end_date_col
    excel_file.unit_col_map = matched
    excel_file.version = (excel_file.version or 0) + 1
    db.commit()

    await generate_ai_mapping(project_id, activities, db)

    return {
        "activities": [_activity_out(a) for a in activities],
        "matched_rooms": len(matched),
        "unmatched_columns": [{"col_index": c.col_index, "header": c.header} for c in unmatched],
        "version": excel_file.version,
    }


@router.get("/{project_id}/activity-excel")
def get_activity_excel(project_id: str, db: Session = Depends(get_db)):
    ef = db.query(ActivityExcelFile).filter(ActivityExcelFile.project_id == project_id).first()
    if not ef:
        raise HTTPException(404, "No Activity Excel uploaded for this project")
    return {
        "file_url": ef.file_url, "original_filename": ef.original_filename,
        "version": ef.version, "updated_at": ef.updated_at, "unit_col_map": ef.unit_col_map,
    }


@router.get("/{project_id}/activity-excel/download")
async def download_activity_excel(project_id: str, db: Session = Depends(get_db)):
    ef = db.query(ActivityExcelFile).filter(ActivityExcelFile.project_id == project_id).first()
    if not ef:
        raise HTTPException(404, "No Activity Excel uploaded for this project")
    file_bytes = await download_media(ef.file_path)
    return Response(
        content=file_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{ef.original_filename or "activity_plan.xlsx"}"'},
    )


@router.put("/{project_id}/activity-excel/unit-map")
def update_unit_map(project_id: str, data: List[UnitMapIn], db: Session = Depends(get_db)):
    ef = db.query(ActivityExcelFile).filter(ActivityExcelFile.project_id == project_id).first()
    if not ef:
        raise HTTPException(404, "No Activity Excel uploaded for this project")
    unit_map = dict(ef.unit_col_map or {})
    for item in data:
        unit_map[item.unit_id] = item.col_index
    ef.unit_col_map = unit_map
    db.commit()
    return {"unit_col_map": ef.unit_col_map}


# ── Component → Activity mapping ─────────────────────────────────────────────

@router.get("/{project_id}/activity-mapping")
def get_activity_mapping(project_id: str, db: Session = Depends(get_db)):
    rows = db.query(ActivityMapping).filter(ActivityMapping.project_id == project_id).all()
    return [
        {"id": m.id, "component_key": m.component_key, "activity_id": m.activity_id,
         "confidence": m.confidence, "source": m.source}
        for m in rows
    ]


@router.put("/{project_id}/activity-mapping")
def set_activity_mapping(project_id: str, data: List[ActivityMappingIn], db: Session = Depends(get_db)):
    """Full replace of the MANUAL mapping rows only — AI-generated rows
    (source="ai") are left untouched so a manual tweak doesn't wipe the rest
    of the auto-proposed mapping."""
    db.query(ActivityMapping).filter(
        ActivityMapping.project_id == project_id, ActivityMapping.source == "manual"
    ).delete()
    for item in data:
        db.add(ActivityMapping(
            project_id=project_id, component_key=item.component_key,
            activity_id=item.activity_id, confidence=item.confidence, source="manual",
        ))
    db.commit()
    return get_activity_mapping(project_id, db)


@router.get("/{project_id}/unmapped-components")
def get_unmapped_components(project_id: str, db: Session = Depends(get_db)):
    rows = (
        db.query(UnmappedComponent)
        .filter(UnmappedComponent.project_id == project_id)
        .order_by(UnmappedComponent.sample_count.desc())
        .all()
    )
    return [
        {"component_key": r.component_key, "sample_count": r.sample_count,
         "first_seen": r.first_seen, "last_seen": r.last_seen}
        for r in rows
    ]


# ── Server-computed Unit × Activity progress matrix ──────────────────────────
# "Unit" is the Activity Excel's "Room" grain (e.g. "A-101") — its value
# already combined-averages that Unit's own Areas (Living/Bathroom); Area-
# level breakdown stays on Floor View.

@router.get("/{project_id}/progress")
def get_progress_matrix(project_id: str, as_of: str = None, db: Session = Depends(get_db)):
    """Without `as_of`, returns the persisted (latest) UnitActivityProgress
    cells. With `as_of=YYYY-MM-DD`, returns what those cells looked like at the
    end of that day — recomputed from the timestamped AIAnalysis history rather
    than the latest-only table, so "kitna kaam us date tak hua tha" is a real
    answer, not an extrapolation. `available_dates` lists every date that can
    be asked for, and is unaffected by `as_of`."""
    p = db.query(Project).get(project_id)
    if not p:
        raise HTTPException(404, "Project not found")

    as_of_date = None
    if as_of:
        try:
            as_of_date = datetime.strptime(as_of, "%Y-%m-%d").date()
        except ValueError:
            raise HTTPException(400, "as_of must be YYYY-MM-DD")

    activities = (
        db.query(Activity).filter(Activity.project_id == project_id)
        .order_by(Activity.sort_order).all()
    )

    locations = []
    unit_ids: List[str] = []
    for f in db.query(Floor).filter(Floor.project_id == project_id).order_by(Floor.floor_number).all():
        for u in f.units:
            locations.append({
                "floor_id": f.id, "floor_number": f.floor_number,
                "unit_id": u.id, "unit_number": u.unit_number,
            })
            unit_ids.append(u.id)

    if as_of_date:
        cells = unit_activity_matrix_as_of(project_id, unit_ids, as_of_date, db)
    else:
        rows = (
            db.query(UnitActivityProgress).filter(UnitActivityProgress.unit_id.in_(unit_ids)).all()
            if unit_ids else []
        )
        cells = [
            {
                "activity_id": r.activity_id, "unit_id": r.unit_id,
                "pct": r.progress_pct, "confidence": r.confidence_score,
                "last_analysed": r.last_analysed,
            }
            for r in rows
        ]

    return {
        "activities": [_activity_out(a) for a in activities],
        "locations": locations,
        "cells": cells,
        "available_dates": analysis_dates_for_project(project_id, db),
        "as_of": as_of_date.isoformat() if as_of_date else None,
    }


@router.get("/{project_id}/progress-series")
def get_progress_series(project_id: str, db: Session = Depends(get_db)):
    """Real progress-over-time: one point per capture date, per Unit, replayed
    from AIAnalysis history in a single pass. Feeds the dashboard's trend
    chart — every point is measured, none interpolated between captures."""
    p = db.query(Project).get(project_id)
    if not p:
        raise HTTPException(404, "Project not found")
    return {"series": progress_series(project_id, db)}


# ── Floors ────────────────────────────────────────────────────────────────────

@router.post("/{project_id}/floors", response_model=FloorOut, status_code=201)
def add_floor(project_id: str, data: FloorCreate, db: Session = Depends(get_db)):
    p = db.query(Project).get(project_id)
    if not p:
        raise HTTPException(404, "Project not found")
    f = Floor(project_id=project_id, **data.model_dump())
    db.add(f)
    db.commit()
    db.refresh(f)
    return f


@router.get("/{project_id}/floors", response_model=List[FloorOut])
def list_floors(project_id: str, db: Session = Depends(get_db)):
    return db.query(Floor).filter(Floor.project_id == project_id).all()


@router.post("/floors/{floor_id}/plan-image", response_model=FloorOut)
async def set_floor_plan_image(floor_id: str, file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Upload (or replace) the floor-plan image a supervisor pins spots onto.
    Separate from floor creation so it can be swapped later without recreating
    the floor and losing its rooms/spots."""
    floor = db.query(Floor).get(floor_id)
    if not floor:
        raise HTTPException(404, "Floor not found")

    contents = await file.read()
    url, _path = await upload_media(contents, file.filename or "plan.png", floor.project_id, floor_id)
    floor.plan_image_url = url
    db.commit()
    db.refresh(floor)
    return floor


# ── Units ─────────────────────────────────────────────────────────────────────

@router.post("/floors/{floor_id}/units", status_code=201)
def add_unit(floor_id: str, data: UnitCreate, db: Session = Depends(get_db)):
    f = db.query(Floor).get(floor_id)
    if not f:
        raise HTTPException(404, "Floor not found")
    u = Unit(floor_id=floor_id, **data.model_dump())
    db.add(u)
    db.commit()
    db.refresh(u)
    return {"id": u.id, "unit_number": u.unit_number, "progress_pct": u.progress_pct}


@router.get("/floors/{floor_id}/units")
def list_units(floor_id: str, db: Session = Depends(get_db)):
    units = db.query(Unit).filter(Unit.floor_id == floor_id).all()
    return [{"id": u.id, "unit_number": u.unit_number, "progress_pct": u.progress_pct} for u in units]


# ── Rooms ─────────────────────────────────────────────────────────────────────

@router.post("/units/{unit_id}/rooms", response_model=RoomOut, status_code=201)
def add_room(unit_id: str, data: RoomCreate, db: Session = Depends(get_db)):
    u = db.query(Unit).get(unit_id)
    if not u:
        raise HTTPException(404, "Unit not found")
    r = Room(unit_id=unit_id, **data.model_dump())
    db.add(r)
    db.commit()
    db.refresh(r)
    return r


@router.get("/units/{unit_id}/rooms", response_model=List[RoomOut])
def list_rooms(unit_id: str, db: Session = Depends(get_db)):
    return db.query(Room).filter(Room.unit_id == unit_id).all()


# A "flat" room hangs directly off a Floor (no Unit) — this is the path the
# mobile app's spot-capture flow uses; the Unit-based routes above are for
# the web's hotel-room/AI-analysis flow. Same Room table, different parent.
@router.post("/floors/{floor_id}/rooms", response_model=RoomOut, status_code=201)
def add_room_to_floor(floor_id: str, data: RoomCreate, db: Session = Depends(get_db)):
    f = db.query(Floor).get(floor_id)
    if not f:
        raise HTTPException(404, "Floor not found")
    r = Room(floor_id=floor_id, **data.model_dump())
    db.add(r)
    db.commit()
    db.refresh(r)
    return r


@router.get("/floors/{floor_id}/rooms", response_model=List[RoomOut])
def list_rooms_for_floor(floor_id: str, db: Session = Depends(get_db)):
    return db.query(Room).filter(Room.floor_id == floor_id).all()


# ── Spots ─────────────────────────────────────────────────────────────────────

@router.post("/rooms/{room_id}/spots", response_model=SpotOut, status_code=201)
def add_spot(room_id: str, data: SpotCreate, db: Session = Depends(get_db)):
    r = db.query(Room).get(room_id)
    if not r:
        raise HTTPException(404, "Room not found")
    s = Spot(room_id=room_id, **data.model_dump())
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


@router.get("/rooms/{room_id}/spots", response_model=List[SpotOut])
def list_spots(room_id: str, db: Session = Depends(get_db)):
    return db.query(Spot).filter(Spot.room_id == room_id).order_by(Spot.sort_order).all()


@router.delete("/spots/{spot_id}", status_code=204)
def delete_spot(spot_id: str, db: Session = Depends(get_db)):
    s = db.query(Spot).get(spot_id)
    if not s:
        raise HTTPException(404, "Spot not found")
    db.delete(s)
    db.commit()
