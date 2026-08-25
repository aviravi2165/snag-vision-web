from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from models import get_db
from models.database import AIAnalysis, Room
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
        }
        for a in analyses
    ]