"""
"Start AI Analysis" — the manual trigger that decouples image upload from AI
processing. See services/job_worker.py for the actual async worker that picks
these jobs up.

Since the unified media pipeline, every analysis job belongs to exactly one
walkthrough (CaptureSession): it never mixes media across walkthroughs, and
running it flips the walkthrough completed -> ai_processing -> ai_completed
(back to completed on failure, so it's retryable). A project that never
created a walkthrough (pre-feature data) falls back to the legacy project-wide
behaviour with walkthrough_id = NULL.
"""
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from models import get_db
from models.database import AnalysisJob, Project, UploadStatus, WalkthroughStatus
from routers.auth import get_current_user
from services.walkthrough_service import resolve_analysis_target

router = APIRouter(prefix="/projects", tags=["analysis-jobs"], dependencies=[Depends(get_current_user)])


def _job_out(job: AnalysisJob) -> dict:
    return {
        "id": job.id, "project_id": job.project_id, "status": job.status.value,
        "walkthrough_id": job.walkthrough_id,
        "total_images": job.total_images, "processed_images": job.processed_images,
        "failed_images": job.failed_images, "error_message": job.error_message,
        "created_at": job.created_at, "started_at": job.started_at, "finished_at": job.finished_at,
    }


@router.get("/{project_id}/analysis/pending-count")
def pending_count(project_id: str, db: Session = Depends(get_db)):
    """Pending count for the analysis target the "Start" button will actually
    run — the project's most recent completed walkthrough, or the legacy
    project-wide set when no walkthrough exists yet. Kept consistent with
    start_analysis so the UI never shows a count that won't be processed."""
    if not db.query(Project).get(project_id):
        raise HTTPException(404, "Project not found")
    _, pending = resolve_analysis_target(project_id, db)
    return {"pending_count": len(pending)}


@router.post("/{project_id}/analysis/start", status_code=202)
def start_analysis(
    project_id: str,
    walkthrough_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """Walkthrough-scoped: only the target walkthrough's pending uploads are
    included. Default target = the project's most recent completed (not yet
    analysed) walkthrough; an explicit walkthrough_id lets a future UI target
    a specific one (re-runs allowed only from completed/ai_completed)."""
    p = db.query(Project).get(project_id)
    if not p:
        raise HTTPException(404, "Project not found")

    wt, pending_uploads = resolve_analysis_target(project_id, db, walkthrough_id)
    if not pending_uploads:
        raise HTTPException(400, "No pending uploads to analyze")

    if wt:
        if wt.status == WalkthroughStatus.ai_processing:
            raise HTTPException(400, "This walkthrough is already being analysed")
        if wt.status not in (WalkthroughStatus.completed, WalkthroughStatus.ai_completed):
            raise HTTPException(
                400,
                f"Walkthrough {wt.number} is not completed — complete it before running AI analysis",
            )
        wt.status = WalkthroughStatus.ai_processing
        wt.ai_started_at = datetime.utcnow()

    job = AnalysisJob(
        project_id=project_id,
        total_images=len(pending_uploads),
        walkthrough_id=wt.id if wt else None,
    )
    db.add(job)
    db.flush()
    for u in pending_uploads:
        u.job_id = job.id
        # Retry semantics: failed uploads are picked up alongside pending ones
        # (see resolve_analysis_target) — reset them to pending so the job runs
        # them like any fresh upload and the Media Manager summary stays honest.
        if u.status == UploadStatus.failed:
            u.status = UploadStatus.pending
    db.commit()
    db.refresh(job)
    return _job_out(job)


@router.get("/{project_id}/analysis/jobs")
def list_jobs(project_id: str, db: Session = Depends(get_db)):
    jobs = (
        db.query(AnalysisJob).filter(AnalysisJob.project_id == project_id)
        .order_by(AnalysisJob.created_at.desc()).all()
    )
    return [_job_out(j) for j in jobs]


@router.get("/{project_id}/analysis/jobs/{job_id}")
def get_job(project_id: str, job_id: str, db: Session = Depends(get_db)):
    job = db.query(AnalysisJob).get(job_id)
    if not job or job.project_id != project_id:
        raise HTTPException(404, "Job not found")
    return _job_out(job)
