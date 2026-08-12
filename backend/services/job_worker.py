"""
"Start AI Analysis" background worker.

Upload and analysis are decoupled: POST /uploads only stores a file
(status="pending"). A user later triggers POST /projects/{id}/analysis/start,
which snapshots every pending upload into a new AnalysisJob. This module is
the worker that actually processes those jobs — an in-process asyncio loop
polling the DB (no new infra/Celery/Redis needed for a single-instance
deployment; see the plan's Phase 2 notes for horizontal-scaling follow-up).

Started once at app startup via main.py: asyncio.create_task(job_worker_loop()).
"""
import asyncio
from datetime import datetime

from models import SessionLocal
from models.database import (
    AnalysisJob, AnalysisJobStatus, CaptureSession, MediaUpload, UploadStatus,
    Room, Project, WalkthroughStatus,
)
from services.gcs_service import download_media
from services.gemini_service import analyse_image, compute_change_flag
from services.mapping_service import recompute_unit_activity_progress
from services.progress_service import full_rollup
from services.excel_service import sync_excel_progress
from models.database import AIAnalysis, ActivityExcelFile, Activity

POLL_INTERVAL_SECONDS = 3
MAX_CONCURRENT_ANALYSES = 4
PER_IMAGE_RETRIES = 2


async def job_worker_loop():
    while True:
        try:
            await _process_one_pending_job()
        except Exception as e:
            print(f"job_worker_loop error: {e}")
        await asyncio.sleep(POLL_INTERVAL_SECONDS)


async def _process_one_pending_job():
    db = SessionLocal()
    try:
        job = (
            db.query(AnalysisJob)
            .filter(AnalysisJob.status == AnalysisJobStatus.pending)
            .order_by(AnalysisJob.created_at.asc())
            .first()
        )
        if not job:
            return
        job.status = AnalysisJobStatus.running
        job.started_at = datetime.utcnow()
        db.commit()
        job_id = job.id
    finally:
        db.close()

    await _run_job(job_id)


async def _run_job(job_id: str):
    db = SessionLocal()
    touched_room_ids = set()
    try:
        job = db.query(AnalysisJob).get(job_id)
        if not job:
            return
        uploads = db.query(MediaUpload).filter(MediaUpload.job_id == job_id).all()
        job.total_images = len(uploads)
        db.commit()

        semaphore = asyncio.Semaphore(MAX_CONCURRENT_ANALYSES)

        async def process_one(upload_id: str):
            async with semaphore:
                await _analyse_one_upload(upload_id, job_id)

        await asyncio.gather(*(process_one(u.id) for u in uploads))

        db.refresh(job)
        touched_room_ids = {u.room_id for u in uploads}
        # Floor View's own rollup stays keyed by Area (Room) — untouched by this refactor.
        for room_id in touched_room_ids:
            full_rollup(room_id, db)

        # Activity Excel / Executive dashboard progress is Unit-grained (a Unit
        # combined-averages its Areas) — recompute once per touched Unit, not per Area.
        touched_unit_ids = set()
        for room_id in touched_room_ids:
            room = db.query(Room).get(room_id)
            if room and room.unit_id:
                touched_unit_ids.add(room.unit_id)
        for unit_id in touched_unit_ids:
            recompute_unit_activity_progress(unit_id, db)

        if touched_room_ids:
            sample_room = db.query(Room).get(next(iter(touched_room_ids)))
            project = _project_for_room(sample_room, db)
            if project:
                await _sync_project_excel(project.id, db)

        job.status = AnalysisJobStatus.done if job.failed_images < job.total_images else AnalysisJobStatus.failed
        job.finished_at = datetime.utcnow()
        _sync_walkthrough_on_finish(db, job)
        db.commit()
    except Exception as e:
        job = db.query(AnalysisJob).get(job_id)
        if job:
            job.status = AnalysisJobStatus.failed
            job.error_message = str(e)
            job.finished_at = datetime.utcnow()
            _sync_walkthrough_on_finish(db, job)
            db.commit()
        print(f"_run_job error: {e}")
    finally:
        db.close()


def _sync_walkthrough_on_finish(db, job):
    """Walkthrough lifecycle flip when a job finishes: ai_processing ->
    ai_completed on success; back to completed on failure (retryable — the
    next "Start AI Analysis" picks it up again). Legacy jobs (walkthrough_id
    NULL) are untouched."""
    if not job.walkthrough_id:
        return
    wt = db.query(CaptureSession).get(job.walkthrough_id)
    if not wt:
        return
    if job.status == AnalysisJobStatus.done:
        wt.status = WalkthroughStatus.ai_completed
        wt.ai_completed_at = datetime.utcnow()
    else:
        wt.status = WalkthroughStatus.completed
        wt.ai_started_at = None
        wt.ai_completed_at = None


async def _analyse_one_upload(upload_id: str, job_id: str):
    """Own DB session per image — safe under concurrent asyncio tasks."""
    db = SessionLocal()
    try:
        upload = db.query(MediaUpload).get(upload_id)
        if not upload:
            return
        room = db.query(Room).get(upload.room_id)
        if not room:
            upload.status = UploadStatus.failed
            db.commit()
            return

        upload.status = UploadStatus.analysing
        db.commit()

        image_bytes = await download_media(upload.gcs_path)

        raw_data, overall_pct, notes, error = {}, 0, "", None
        for attempt in range(PER_IMAGE_RETRIES + 1):
            raw_data, overall_pct, notes = await analyse_image(image_bytes, upload.media_type, room.name)
            if raw_data:
                error = None
                break
            error = notes

        job = db.query(AnalysisJob).get(job_id)
        if not raw_data:
            upload.status = UploadStatus.failed
            if job:
                job.failed_images += 1
            db.commit()
            return

        components = raw_data.get("components", {})
        prev = (
            db.query(AIAnalysis)
            .filter(AIAnalysis.room_id == upload.room_id)
            .order_by(AIAnalysis.analysed_at.desc())
            .first()
        )
        prev_pct = prev.overall_pct if prev else None
        delta, flag = compute_change_flag(prev_pct, overall_pct)

        analysis = AIAnalysis(
            room_id=upload.room_id,
            upload_id=upload.id,
            components=components,
            overall_pct=overall_pct,
            ai_notes=notes,
            prev_overall_pct=prev_pct,
            delta_pct=delta,
            change_flag=flag,
        )
        db.add(analysis)
        upload.status = UploadStatus.done
        if job:
            job.processed_images += 1
        db.commit()
    except Exception as e:
        db.rollback()
        upload = db.query(MediaUpload).get(upload_id)
        if upload:
            upload.status = UploadStatus.failed
        job = db.query(AnalysisJob).get(job_id)
        if job:
            job.failed_images += 1
        db.commit()
        print(f"_analyse_one_upload error for {upload_id}: {e}")
    finally:
        db.close()


def _project_for_room(room: Room, db) -> Project:
    if room.unit and room.unit.floor:
        return db.query(Project).get(room.unit.floor.project_id)
    if room.floor:
        return db.query(Project).get(room.floor.project_id)
    return None


async def _sync_project_excel(project_id: str, db):
    """Re-open the project's stored master Excel, write only the cells that
    have real progress data, save it back in place, bump version. No-op if
    the project never uploaded an Activity Excel."""
    from models.database import UnitActivityProgress
    from services.excel_service import parse_activity_excel
    from services.gcs_service import upload_bytes_to_path

    excel_file = db.query(ActivityExcelFile).filter(ActivityExcelFile.project_id == project_id).first()
    if not excel_file or not excel_file.unit_col_map:
        return
    activities = db.query(Activity).filter(Activity.project_id == project_id).all()
    if not activities:
        return

    unit_ids = list(excel_file.unit_col_map.keys())
    rows = (
        db.query(UnitActivityProgress)
        .filter(UnitActivityProgress.unit_id.in_(unit_ids))
        .all()
    )
    progress_by_activity_unit = {(r.activity_id, r.unit_id): r.progress_pct for r in rows}

    file_bytes = await download_media(excel_file.file_path)
    activity_col_index = parse_activity_excel(file_bytes).activity_col_index
    updated_bytes = sync_excel_progress(
        file_bytes=file_bytes,
        header_row=1,
        activity_col_index=activity_col_index,
        activities=activities,
        unit_col_map=excel_file.unit_col_map,
        progress_by_activity_unit=progress_by_activity_unit,
    )
    await upload_bytes_to_path(
        updated_bytes, excel_file.file_path,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
    excel_file.version += 1
    excel_file.updated_at = datetime.utcnow()
    db.commit()
