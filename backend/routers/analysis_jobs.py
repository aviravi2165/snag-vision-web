"""
"Start AI Analysis" — the manual trigger that decouples image upload from AI
processing. See services/job_worker.py for the actual async worker that picks
these jobs up.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from models import get_db
from models.database import AnalysisJob, MediaUpload, UploadStatus, Project, Floor
from routers.auth import get_current_user
from typing import List

router = APIRouter(prefix="/projects", tags=["analysis-jobs"], dependencies=[Depends(get_current_user)])


def _project_room_ids(project_id: str, db: Session) -> List[str]:
    room_ids: List[str] = []
    for f in db.query(Floor).filter(Floor.project_id == project_id).all():
        room_ids.extend(r.id for r in f.rooms)
        for u in f.units:
            room_ids.extend(r.id for r in u.rooms)
    return room_ids


def _job_out(job: AnalysisJob) -> dict:
    return {
        "id": job.id, "project_id": job.project_id, "status": job.status.value,
        "total_images": job.total_images, "processed_images": job.processed_images,
        "failed_images": job.failed_images, "error_message": job.error_message,
        "created_at": job.created_at, "started_at": job.started_at, "finished_at": job.finished_at,
    }


@router.get("/{project_id}/analysis/pending-count")
def pending_count(project_id: str, db: Session = Depends(get_db)):
    room_ids = _project_room_ids(project_id, db)
    count = (
        db.query(MediaUpload)
        .filter(MediaUpload.room_id.in_(room_ids), MediaUpload.status == UploadStatus.pending)
        .count()
        if room_ids else 0
    )
    return {"pending_count": count}


@router.post("/{project_id}/analysis/start", status_code=202)
def start_analysis(project_id: str, db: Session = Depends(get_db)):
    p = db.query(Project).get(project_id)
    if not p:
        raise HTTPException(404, "Project not found")

    room_ids = _project_room_ids(project_id, db)
    pending_uploads = (
        db.query(MediaUpload)
        .filter(MediaUpload.room_id.in_(room_ids), MediaUpload.status == UploadStatus.pending)
        .all()
        if room_ids else []
    )
    if not pending_uploads:
        raise HTTPException(400, "No pending uploads to analyze")

    job = AnalysisJob(project_id=project_id, total_images=len(pending_uploads))
    db.add(job)
    db.flush()
    for u in pending_uploads:
        u.job_id = job.id
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
