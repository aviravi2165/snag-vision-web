from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.orm import Session
from models import get_db
from models.database import Project, Floor, Unit, Room, Spot, UserRole
from schemas.models import (
    ProjectCreate, ProjectOut, FloorCreate, FloorOut,
    UnitCreate, RoomCreate, RoomOut, SpotCreate, SpotOut,
)
from services.progress_service import build_dashboard
from services.gcs_service import upload_media
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
