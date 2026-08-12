"""
Walkthroughs — the numbered capture-session entity behind the unified media
pipeline. Exposed to the UI everywhere as \"Walkthrough\"; the underlying table
is the generic CaptureSession (session_type default \"walkthrough\"), see
services/walkthrough_service.py for the full lifecycle and rules.

Endpoints:
  GET  /projects/{id}/walkthroughs            list (history strip + \"Start Walkthrough N\")
  POST /projects/{id}/walkthroughs            explicit create (number = max+1; 400 if one is active)
  GET  /projects/{id}/walkthroughs/current    the one active walkthrough, 404 if none
  POST /walkthroughs/{id}/request-complete    validates -> ready_to_complete (+ non-blocking warnings)
  POST /walkthroughs/{id}/complete            ready_to_complete -> completed (read-only from here)
"""
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from models import get_db
from models.database import CaptureSession, MediaUpload, UploadStatus, User, WalkthroughStatus
from routers.auth import get_current_user
from schemas.models import RequestCompleteOut, WalkthroughOut
from services.walkthrough_service import (
    create_walkthrough, get_current_walkthrough, get_walkthrough_or_404,
    missing_rooms_for_walkthrough,
)

router = APIRouter(tags=["walkthroughs"], dependencies=[Depends(get_current_user)])


# ── Serializers ──────────────────────────────────────────────────────────────

def _walkthrough_out(wt: CaptureSession, db: Session) -> WalkthroughOut:
    # One query returns every status for this walkthrough; counts are summed in
    # a single pass — no per-status round-trips.
    statuses = [
        s for (s,) in db.query(MediaUpload.status)
        .filter(MediaUpload.walkthrough_id == wt.id)
        .all()
    ]
    total = len(statuses)
    pending = sum(1 for s in statuses if s == UploadStatus.pending)
    done = sum(1 for s in statuses if s == UploadStatus.done)
    failed = sum(1 for s in statuses if s == UploadStatus.failed)
    return WalkthroughOut(
        id=wt.id, project_id=wt.project_id, session_type=wt.session_type,
        number=wt.number, status=wt.status.value,
        started_at=wt.started_at, ready_at=wt.ready_at, completed_at=wt.completed_at,
        ai_started_at=wt.ai_started_at, ai_completed_at=wt.ai_completed_at,
        created_by=wt.created_by, created_at=wt.created_at,
        capture_count=total, pending_count=pending, done_count=done, failed_count=failed,
    )


# ── Routes ───────────────────────────────────────────────────────────────────

@router.get("/projects/{project_id}/walkthroughs", response_model=List[WalkthroughOut])
def list_walkthroughs(project_id: str, db: Session = Depends(get_db)):
    """All walkthroughs for the project, newest first — the history strip that
    lets the UI compute the next number for \"Start Walkthrough N\"."""
    rows = (
        db.query(CaptureSession)
        .filter(CaptureSession.project_id == project_id)
        .order_by(CaptureSession.number.desc())
        .all()
    )
    return [_walkthrough_out(wt, db) for wt in rows]


@router.post("/projects/{project_id}/walkthroughs", response_model=WalkthroughOut, status_code=201)
def start_walkthrough(
    project_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Explicit creation only — never auto-created. 400 while an active
    walkthrough exists (sequential numbers, no skipping, one at a time)."""
    wt = create_walkthrough(project_id, db, created_by=user.id)
    db.commit()
    db.refresh(wt)
    return _walkthrough_out(wt, db)


@router.get("/projects/{project_id}/walkthroughs/current", response_model=WalkthroughOut)
def current_walkthrough(project_id: str, db: Session = Depends(get_db)):
    """The one active (non-completed) walkthrough, or 404 — the frontend shows
    \"Start Walkthrough N\" instead of a status bar when this 404s."""
    wt = get_current_walkthrough(project_id, db)
    if not wt:
        raise HTTPException(404, "No active walkthrough")
    return _walkthrough_out(wt, db)


@router.post("/walkthroughs/{walkthrough_id}/request-complete", response_model=RequestCompleteOut)
def request_complete_walkthrough(walkthrough_id: str, db: Session = Depends(get_db)):
    """Validate + move to ready_to_complete. Hard 400 on zero captures; returns
    the expected-but-missing rooms as non-blocking warnings for the UI's
    \"Go back / Complete anyway\" confirmation dialog."""
    wt = get_walkthrough_or_404(walkthrough_id, db)
    if wt.status in (WalkthroughStatus.completed, WalkthroughStatus.ai_processing, WalkthroughStatus.ai_completed):
        raise HTTPException(400, "This walkthrough is already completed")
    capture_count = (
        db.query(MediaUpload).filter(MediaUpload.walkthrough_id == wt.id).count()
    )
    if capture_count == 0:
        raise HTTPException(400, "This walkthrough has no captures yet — capture at least one photo first")
    warnings = missing_rooms_for_walkthrough(wt, db)
    wt.status = WalkthroughStatus.ready_to_complete
    wt.ready_at = datetime.utcnow()
    db.commit()
    db.refresh(wt)
    return RequestCompleteOut(walkthrough=_walkthrough_out(wt, db), warnings=warnings)


@router.post("/walkthroughs/{walkthrough_id}/complete", response_model=WalkthroughOut)
def complete_walkthrough(walkthrough_id: str, db: Session = Depends(get_db)):
    """Confirm-complete: only valid from ready_to_complete (the dialog the user
    already saw came from request-complete). From here the walkthrough is
    read-only until \"Start AI Analysis\" flips it to ai_processing."""
    wt = get_walkthrough_or_404(walkthrough_id, db)
    if wt.status != WalkthroughStatus.ready_to_complete:
        raise HTTPException(
            400,
            "Walkthrough must be requested for completion first (request-complete) before confirming",
        )
    wt.status = WalkthroughStatus.completed
    wt.completed_at = datetime.utcnow()
    db.commit()
    db.refresh(wt)
    return _walkthrough_out(wt, db)
