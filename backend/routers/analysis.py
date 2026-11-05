from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, or_
from sqlalchemy.orm import Session
from models import get_db
from models.database import AIAnalysis, Floor, MediaUpload, Project, Room, Spot, Unit
from schemas.models import AnalysisOut
from routers.auth import get_current_user
from services.activity_catalog import standard_breakdown
from typing import List

router = APIRouter(prefix="/analysis", tags=["analysis"], dependencies=[Depends(get_current_user)])


def _mapped_entries(components: dict, db: Session) -> List[dict]:
    """Raw Gemini components rolled into the STANDARD 12-category catalog via
    the global classifier (services/activity_catalog.py) — independent of the
    project's own Activity plan, which stays the Executive dashboard's
    Activity-Excel BoQ view. This is what AI Analysis / Floor View display
    instead of the long raw component list."""
    return [
        {
            "name": item["name"],
            "pct": round(item["pct"], 1),
            "confidence": round(item["confidence"], 2),
        }
        for item in standard_breakdown(components, db)
    ]

@router.get("/room/{room_id}", response_model=List[AnalysisOut])
def get_room_analyses(room_id: str, limit: int = 10, db: Session = Depends(get_db)):
    return (
        db.query(AIAnalysis)
        .filter(AIAnalysis.room_id == room_id)
        .order_by(AIAnalysis.analysed_at.desc())
        .limit(limit)
        .all()
    )

@router.get("/room/{room_id}/latest")
def get_latest_analysis(room_id: str, db: Session = Depends(get_db)):
    a = (
        db.query(AIAnalysis)
        .filter(AIAnalysis.room_id == room_id)
        .order_by(AIAnalysis.analysed_at.desc())
        .first()
    )
    if not a:
        raise HTTPException(404, "No analysis found for this room")

    # 🟢 Clean components dynamically: removes non-numeric or extra text fields
    clean_components = {
        k: v for k, v in a.components.items()
        if k not in ["overall_pct", "notes", "ai_notes"] and v is not None
    } if a.components else {}

    # Return structure formatted safely for frontend chart and cards
    return {
        "id": a.id,
        "room_id": a.room_id,
        "upload_id": a.upload_id,
        "overall_pct": a.overall_pct,
        "ai_notes": a.ai_notes,
        "notes": a.ai_notes, # Frontend fallbacks
        "prev_overall_pct": a.prev_overall_pct,
        "delta_pct": a.delta_pct,
        "change_flag": a.change_flag,
        "analysed_at": a.analysed_at,
        "components": clean_components,  # Pure numeric keys for Radar Chart
        "mapped": _mapped_entries(a.components, db),
        "details": a.details,            # defects, safety, materials, pending work... (null on older analyses)
    }

@router.get("/room/{room_id}/change-detection")
def get_change_detection(room_id: str, db: Session = Depends(get_db)):
    analyses = (
        db.query(AIAnalysis)
        .filter(AIAnalysis.room_id == room_id)
        .order_by(AIAnalysis.analysed_at.asc())
        .all()
    )
    return [
        {
            "date": a.analysed_at.isoformat(),
            "overall_pct": a.overall_pct,
            "delta": a.delta_pct,
            "flag": a.change_flag,
            # The analysed/completed description *as written on that date* —
            # without this the historical view has no note to show and
            # collapses to just the pending list. Never substitute the latest
            # note here: it would describe work that hadn't happened yet.
            "ai_notes": a.ai_notes,
            # 🟢 Clean components here too for historical chart consistency
            "components": {
                k: v for k, v in a.components.items()
                if k not in ["overall_pct", "notes", "ai_notes"] and v is not None
            } if a.components else {},
            "mapped": _mapped_entries(a.components, db),
            "details": a.details,
        }
        for a in analyses
    ]


SEVERITY_RANK = {"critical": 0, "high": 1, "medium": 2, "low": 3}


@router.get("/project/{project_id}/insights")
def get_project_insights(project_id: str, db: Session = Depends(get_db)):
    """Project-wide AI findings for the dashboard: the *current* snags, safety
    issues and room states, taken from each room's latest analysis (an older
    analysis's defects are superseded by the newer visit, so they're not
    counted twice). A fixed number of queries regardless of project size."""
    if not db.query(Project).get(project_id):
        raise HTTPException(404, "Project not found")

    floors = {f.id: f for f in db.query(Floor).filter(Floor.project_id == project_id).all()}
    units = {u.id: u for u in db.query(Unit).filter(Unit.floor_id.in_(floors.keys())).all()} if floors else {}
    rooms = (
        db.query(Room).filter(or_(Room.floor_id.in_(floors.keys()), Room.unit_id.in_(units.keys()))).all()
        if floors else []
    )
    if not rooms:
        return _empty_insights(0)

    def room_path(r: Room) -> str:
        unit = units.get(r.unit_id)
        floor = floors.get(unit.floor_id if unit else r.floor_id)
        parts = [f"Floor {floor.floor_number}"] if floor else []
        if unit:
            parts.append(unit.unit_number)
        parts.append(r.name)
        return " › ".join(parts)

    room_ids = [r.id for r in rooms]

    # A flat room whose spots all came from Layout Setup hotspots is just the
    # auto-created "Layout" container (_sync_hotspots_to_spots): photos taken at
    # those points are filed under the hotspot's real room, so nothing is ever
    # photographed *in* it — counting it made "rooms inspected" show a room that
    # could never be inspected.
    spot_keys = {}
    for rid, key in db.query(Spot.room_id, Spot.client_spot_id).filter(Spot.room_id.in_(room_ids)):
        spot_keys.setdefault(rid, []).append(key or "")
    containers = {
        r.id for r in rooms
        if r.unit_id is None and all(k.startswith("hotspot:") for k in spot_keys.get(r.id, []))
    }

    latest_at = (
        db.query(AIAnalysis.room_id, func.max(AIAnalysis.analysed_at).label("at"))
        .filter(AIAnalysis.room_id.in_(room_ids))
        .group_by(AIAnalysis.room_id)
        .subquery()
    )
    latest = (
        db.query(AIAnalysis, MediaUpload.gcs_url)
        .join(latest_at, (AIAnalysis.room_id == latest_at.c.room_id) & (AIAnalysis.analysed_at == latest_at.c.at))
        .outerjoin(MediaUpload, MediaUpload.id == AIAnalysis.upload_id)
        .all()
    )
    by_room = {r.id: r for r in rooms}
    # Rooms that can be inspected — plus any container that already has an
    # analysis (photos filed there before the fix), so nothing analysed is hidden.
    inspectable = {r.id for r in rooms if r.id not in containers} | {a.room_id for a, _ in latest}

    # Completion over time, from the room analyses themselves (the activity-based
    # series needs an Activity plan; many projects don't have one). One point per
    # day: the average of every room's most recent reading as of that day.
    history = (
        db.query(AIAnalysis.room_id, AIAnalysis.overall_pct, AIAnalysis.analysed_at)
        .filter(AIAnalysis.room_id.in_(room_ids))
        .order_by(AIAnalysis.analysed_at.asc())
        .all()
    )
    trend, running = [], {}
    for rid, pct, at in history:
        running[rid] = pct or 0
        day = at.date().isoformat()
        point = {"date": day, "pct": round(sum(running.values()) / len(running), 1), "rooms": len(running)}
        if trend and trend[-1]["date"] == day:
            trend[-1] = point          # several photos on one day -> that day's end state
        else:
            trend.append(point)

    defects, safety, room_rows = [], [], []
    severity_counts = {s: 0 for s in SEVERITY_RANK}
    last_analysed = None
    for a, image_url in latest:
        room = by_room[a.room_id]
        path = room_path(room)
        d = a.details or {}
        last_analysed = max(last_analysed, a.analysed_at) if last_analysed else a.analysed_at
        room_defects = d.get("defects") or []
        for x in room_defects:
            sev = x.get("severity") if x.get("severity") in SEVERITY_RANK else "medium"
            severity_counts[sev] += 1
            defects.append({**x, "severity": sev, "room_id": room.id, "room_path": path,
                             "analysed_at": a.analysed_at, "image_url": image_url})
        for s in d.get("safety_issues") or []:
            safety.append({**s, "room_id": room.id, "room_path": path, "analysed_at": a.analysed_at})
        worst = min((SEVERITY_RANK.get(x.get("severity"), 2) for x in room_defects), default=None)
        room_rows.append({
            "room_id": room.id, "room_path": path, "overall_pct": a.overall_pct,
            "summary": d.get("summary") or a.ai_notes, "room_type": d.get("room_type"),
            "housekeeping": d.get("housekeeping"), "defect_count": len(room_defects),
            "worst_severity": next((k for k, v in SEVERITY_RANK.items() if v == worst), None),
            "image_usable": (d.get("image_quality") or {}).get("usable", True),
            "change_flag": a.change_flag, "analysed_at": a.analysed_at, "image_url": image_url,
        })

    newest_first = lambda item: -(item["analysed_at"].timestamp() if item["analysed_at"] else 0)
    defects.sort(key=lambda x: (SEVERITY_RANK[x["severity"]], newest_first(x)))
    safety.sort(key=lambda x: (SEVERITY_RANK.get(x.get("severity"), 2), newest_first(x)))
    room_rows.sort(key=lambda r: (SEVERITY_RANK.get(r["worst_severity"], 9), -r["defect_count"], r["room_path"]))

    return {
        "total_rooms": len(inspectable),
        "analysed_rooms": len(room_rows),
        "trend": trend,
        "last_analysed_at": last_analysed,
        "severity_counts": severity_counts,
        "defect_count": len(defects),
        "safety_count": len(safety),
        "defects": defects,
        "safety_issues": safety,
        "rooms": room_rows,
    }


def _empty_insights(total_rooms: int) -> dict:
    return {
        "total_rooms": total_rooms, "analysed_rooms": 0, "last_analysed_at": None, "trend": [],
        "severity_counts": {s: 0 for s in SEVERITY_RANK}, "defect_count": 0, "safety_count": 0,
        "defects": [], "safety_issues": [], "rooms": [],
    }