"""
Progress aggregation service.
Rolls up room-level AI analysis results through unit → floor → project hierarchy.
"""
from sqlalchemy import and_, func
from sqlalchemy.orm import Session
from models.database import Project, Floor, Unit, Room, AIAnalysis
from typing import Optional
import statistics


def recalc_room(room_id: str, db: Session) -> float:
    """Average of latest AI analysis components for a room."""
    latest = (
        db.query(AIAnalysis)
        .filter(AIAnalysis.room_id == room_id)
        .order_by(AIAnalysis.analysed_at.desc())
        .first()
    )
    if not latest:
        return 0.0
    pct = latest.overall_pct or 0.0
    room = db.query(Room).get(room_id)
    if room:
        room.progress_pct = round(pct, 1)
        room.last_analysed = latest.analysed_at
        db.commit()
    return pct


def recalc_unit(unit_id: str, db: Session) -> float:
    unit = db.query(Unit).get(unit_id)
    if not unit or not unit.rooms:
        return 0.0
    pcts = [r.progress_pct for r in unit.rooms]
    avg = round(statistics.mean(pcts), 1) if pcts else 0.0
    unit.progress_pct = avg
    db.commit()
    return avg


def recalc_floor(floor_id: str, db: Session) -> float:
    floor = db.query(Floor).get(floor_id)
    if not floor or not floor.units:
        return 0.0
    pcts = [u.progress_pct for u in floor.units]
    avg = round(statistics.mean(pcts), 1) if pcts else 0.0
    floor.progress_pct = avg
    db.commit()
    return avg


def recalc_project(project_id: str, db: Session) -> float:
    project = db.query(Project).get(project_id)
    if not project or not project.floors:
        return 0.0
    pcts = [f.progress_pct for f in project.floors]
    avg = round(statistics.mean(pcts), 1) if pcts else 0.0
    return avg


def full_rollup(room_id: str, db: Session):
    """Trigger full recalculation up the hierarchy after a new analysis."""
    room = db.query(Room).get(room_id)
    if not room:
        return
    recalc_room(room_id, db)
    unit = room.unit
    if unit:
        recalc_unit(unit.id, db)
        floor = unit.floor
        if floor:
            recalc_floor(floor.id, db)


def _count_delayed_rooms(project: Project, db: Session) -> int:
    """Rooms of THIS project whose latest analysis is flagged rework, or stalled
    while still unfinished. This used to count every stalled/rework analysis in
    the whole database — other projects' included, and old visits that a newer
    one had already superseded. A room at 95%+ that hasn't changed since the
    last visit is simply finished, not delayed."""
    room_ids = [r.id for f in project.floors for u in f.units for r in u.rooms]
    room_ids += [r.id for f in project.floors for r in f.rooms]
    if not room_ids:
        return 0
    latest_at = (
        db.query(AIAnalysis.room_id, func.max(AIAnalysis.analysed_at).label("at"))
        .filter(AIAnalysis.room_id.in_(room_ids))
        .group_by(AIAnalysis.room_id)
        .subquery()
    )
    latest = (
        db.query(AIAnalysis)
        .join(latest_at, and_(AIAnalysis.room_id == latest_at.c.room_id, AIAnalysis.analysed_at == latest_at.c.at))
        .all()
    )
    return sum(
        1 for a in latest
        if a.change_flag == "rework" or (a.change_flag == "stalled" and (a.overall_pct or 0) < 95)
    )


def build_dashboard(project_id: str, db: Session) -> dict:
    """Build full hierarchical progress dict for executive dashboard."""
    project = db.query(Project).get(project_id)
    if not project:
        return {}

    floors_out = []
    all_floor_pcts = []

    for floor in sorted(project.floors, key=lambda f: f.floor_number):
        units_out = []
        for unit in floor.units:
            rooms_out = []
            for room in unit.rooms:
                latest = (
                    db.query(AIAnalysis)
                    .filter(AIAnalysis.room_id == room.id)
                    .order_by(AIAnalysis.analysed_at.desc())
                    .first()
                )
                rooms_out.append({
                    "room_id": room.id,
                    "room_name": room.name,
                    "pct": room.progress_pct,
                    "components": latest.components if latest else None,
                    "change_flag": latest.change_flag if latest else None,
                })
            units_out.append({
                "unit_id": unit.id,
                "unit_number": unit.unit_number,
                "pct": unit.progress_pct,
                "rooms": rooms_out,
            })
        floors_out.append({
            "floor_id": floor.id,
            "floor_number": floor.floor_number,
            "label": floor.label,
            "pct": floor.progress_pct,
            "units": units_out,
        })
        all_floor_pcts.append(floor.progress_pct)

    overall = round(
        sum(all_floor_pcts) / len(all_floor_pcts), 1
    ) if all_floor_pcts else 0.0

    delayed = _count_delayed_rooms(project, db)

    return {
        "project_id": project.id,
        "project_name": project.name,
        "overall_pct": overall,
        "floors": floors_out,
        "active_delays": delayed,
        "est_completion": None,
        "weekly_trend": [],
    }
