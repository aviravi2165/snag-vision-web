"""
Walkthrough (CaptureSession) service — the shared helpers behind every capture
write path and the walkthrough-scoped analysis trigger.

The CaptureSession table is generic (`session_type` column, default
"walkthrough") but every endpoint/UI in this codebase speaks only in
"Walkthroughs" — see models/database.py::CaptureSession for the reasoning.

Lifecycle (also documented on WalkthroughStatus):

    draft --(first capture)--> capturing --(request-complete)--> ready_to_complete
    ready_to_complete --(new capture)--> capturing          [auto-revert]
    ready_to_complete --(confirm complete)--> completed
    completed --(analysis start)--> ai_processing --(job done)--> ai_completed
                                     --(job failed)--> completed (retryable)

Rules enforced here (never just in the frontend):
  * Rows are NEVER auto-created — a walkthrough only exists after an explicit
    POST /projects/{id}/walkthroughs.
  * A project has at most one active (non-completed) walkthrough.
  * Capture endpoints 400 unless the project has an active walkthrough — that
    is what makes the UI show "Start Walkthrough N" instead of silently
    accepting captures outside any session.
  * Numbers are sequential and never skipped — enforced in the DB by
    UNIQUE(project_id, session_type, number); next_walkthrough_number() just
    computes max+1.
"""
from datetime import datetime
from typing import List, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy.orm import Session

from models.database import (
    CaptureSession, Floor, Hotspot, MediaUpload, Project, Room, Unit,
    UploadStatus, WalkthroughStatus,
)

# Statuses that make a walkthrough read-only for captures.
LOCKED_STATUSES = (
    WalkthroughStatus.completed,
    WalkthroughStatus.ai_processing,
    WalkthroughStatus.ai_completed,
)


# ── Lookups ──────────────────────────────────────────────────────────────────

def get_current_walkthrough(project_id: str, db: Session) -> Optional[CaptureSession]:
    """The project's single active (non-completed) walkthrough, or None.

    A project can have at most one by construction (creation 400s while one
    exists), so ordering here is only a tie-break for defensive safety.
    """
    return (
        db.query(CaptureSession)
        .filter(
            CaptureSession.project_id == project_id,
            CaptureSession.status.notin_(LOCKED_STATUSES),
        )
        .order_by(CaptureSession.number.desc())
        .first()
    )


def get_walkthrough_or_404(walkthrough_id: str, db: Session) -> CaptureSession:
    wt = db.query(CaptureSession).get(walkthrough_id)
    if not wt:
        raise HTTPException(404, "Walkthrough not found")
    return wt


# ── Creation ─────────────────────────────────────────────────────────────────

def next_walkthrough_number(project_id: str, db: Session) -> int:
    top = (
        db.query(CaptureSession)
        .filter(CaptureSession.project_id == project_id)
        .order_by(CaptureSession.number.desc())
        .first()
    )
    return (top.number + 1) if top else 1


def create_walkthrough(project_id: str, db: Session, created_by: Optional[str] = None) -> CaptureSession:
    """Explicit creation only — never auto-created anywhere. 400 if the project
    already has an active (non-completed) walkthrough."""
    project = db.query(Project).get(project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    if get_current_walkthrough(project_id, db):
        raise HTTPException(
            400,
            "Project already has an active walkthrough — complete it before starting a new one",
        )
    wt = CaptureSession(
        project_id=project_id,
        session_type="walkthrough",
        number=next_walkthrough_number(project_id, db),
        status=WalkthroughStatus.draft,
        created_by=created_by,
    )
    db.add(wt)
    return wt


# ── Capture gating ───────────────────────────────────────────────────────────

def require_capturable(project_id: str, db: Session) -> CaptureSession:
    """The walkthrough a new capture must be stamped with — the single gate
    shared by Site Capture (site.py), the Upload page (uploads.py) and the
    mobile app (mobile.py).

    * No active walkthrough -> 400 (\"Start a walkthrough first\").
    * First capture flips draft -> capturing and stamps started_at.
    * A capture arriving while ready_to_complete auto-reverts it to capturing
      (\"not ready anymore\").

    Caller commits; this flushes the state transition into the caller's session.
    """
    wt = get_current_walkthrough(project_id, db)
    if not wt:
        raise HTTPException(
            400,
            "Start a walkthrough first — captures are disabled while no walkthrough is active for this project",
        )
    if wt.status == WalkthroughStatus.draft:
        wt.status = WalkthroughStatus.capturing
        wt.started_at = datetime.utcnow()
    elif wt.status == WalkthroughStatus.ready_to_complete:
        wt.status = WalkthroughStatus.capturing
        wt.ready_at = None
    db.flush()
    return wt


def project_room_ids(project_id: str, db: Session) -> List[str]:
    """Every Room id in the project — under both parentings (web: Unit->Room,
    mobile: flat Floor->Room)."""
    room_ids: List[str] = []
    for f in db.query(Floor).filter(Floor.project_id == project_id).all():
        room_ids.extend(r.id for r in f.rooms)
        for u in f.units:
            room_ids.extend(r.id for r in u.rooms)
    return room_ids


# ── request-complete validation ─────────────────────────────────────────────

def missing_rooms_for_walkthrough(wt: CaptureSession, db: Session) -> List[dict]:
    """Expected rooms with no capture yet: rooms that have a Hotspot pinned in
    Layout Setup (real Room.id guaranteed by the UI's unit+room guard) but no
    MediaUpload in this walkthrough. Non-blocking warnings, not a hard error."""
    pinned = [
        hs.room_id
        for hs in db.query(Hotspot).filter(Hotspot.project_id == wt.project_id).all()
        if hs.room_id
    ]
    if not pinned:
        return []
    captured = {
        u.room_id
        for u in db.query(MediaUpload).filter(MediaUpload.walkthrough_id == wt.id).all()
    }
    missing = [rid for rid in pinned if rid not in captured]
    if not missing:
        return []

    rooms = {r.id: r for r in db.query(Room).filter(Room.id.in_(missing)).all()}
    out = []
    for rid in missing:
        r = rooms.get(rid)
        floor_number = None
        if r:
            if r.floor:
                floor_number = r.floor.floor_number
            elif r.unit and r.unit.floor:
                floor_number = r.unit.floor.floor_number
        out.append({
            "room_id": rid,
            "room_name": r.name if r else None,
            "floor_number": floor_number,
        })
    return out


# ── Analysis targeting ───────────────────────────────────────────────────────

def resolve_analysis_target(
    project_id: str,
    db: Session,
    walkthrough_id: Optional[str] = None,
) -> Tuple[Optional[CaptureSession], List[MediaUpload]]:
    """(walkthrough, pending_uploads) for a \"Start AI Analysis\" run.

    * Explicit walkthrough_id — must belong to the project; only that
      walkthrough's pending (or failed — retryable) uploads are included, never a mixed batch.
    * Default — the project's most recent *completed* walkthrough (one not yet
      ai_processing/ai_completed). A failed job flips the walkthrough back to
      completed (see job_worker.py), so \"completed\" doubles as \"analysable\".
    * Legacy fallback — a project that never created a walkthrough (all rows
      pre-date the feature) keeps working exactly as before: every pending
      upload in the project, job stamped with walkthrough_id=NULL.
    """
    if walkthrough_id:
        wt = get_walkthrough_or_404(walkthrough_id, db)
        if wt.project_id != project_id:
            raise HTTPException(400, "Walkthrough does not belong to this project")
        pending = (
            db.query(MediaUpload)
            .filter(
                MediaUpload.walkthrough_id == wt.id,
                MediaUpload.status.in_((UploadStatus.pending, UploadStatus.failed)),
            )
            .all()
        )
        return wt, pending

    wt = (
        db.query(CaptureSession)
        .filter(
            CaptureSession.project_id == project_id,
            CaptureSession.status == WalkthroughStatus.completed,
        )
        .order_by(CaptureSession.number.desc())
        .first()
    )
    if wt:
        pending = (
            db.query(MediaUpload)
            .filter(
                MediaUpload.walkthrough_id == wt.id,
                MediaUpload.status.in_((UploadStatus.pending, UploadStatus.failed)),
            )
            .all()
        )
        return wt, pending

    room_ids = project_room_ids(project_id, db)
    pending = (
        db.query(MediaUpload)
        .filter(
            MediaUpload.room_id.in_(room_ids),
            MediaUpload.status.in_((UploadStatus.pending, UploadStatus.failed)),
        )
        .all()
        if room_ids
        else []
    )
    return None, pending
