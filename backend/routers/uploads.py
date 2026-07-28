from fastapi import APIRouter, Depends, UploadFile, File, Form, HTTPException
from sqlalchemy.orm import Session
from models import get_db
from models.database import MediaUpload, Room, UploadStatus, Project
from schemas.models import UploadOut
from services.gcs_service import upload_media
from services.gemini_service import analyse_image, compute_change_flag
from services.progress_service import full_rollup
from models.database import AIAnalysis
from routers.auth import get_current_user
from typing import List
import mimetypes

router = APIRouter(prefix="/uploads", tags=["uploads"], dependencies=[Depends(get_current_user)])

IMAGE_MIMES = {"image/jpeg", "image/png", "image/webp"}
MAX_SIZE_MB = 20


@router.post("", response_model=UploadOut, status_code=201)
async def upload_file(
    room_id: str = Form(...),
    supervisor_id: str = Form(...),
    notes: str = Form(""),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    room = db.query(Room).get(room_id)
    if not room:
        raise HTTPException(404, "Room not found")

    contents = await file.read()
    if len(contents) > MAX_SIZE_MB * 1024 * 1024:
        raise HTTPException(413, f"File too large (max {MAX_SIZE_MB} MB)")

    mime = file.content_type or mimetypes.guess_type(file.filename)[0] or "image/jpeg"
    media_type_label = "photo" if "image" in mime else "video" if "video" in mime else "360"

    # Derive project_id from room hierarchy
    unit = room.unit
    floor = unit.floor if unit else None
    project_id = floor.project_id if floor else "unknown"

    gcs_url, gcs_path = await upload_media(contents, file.filename, project_id, room_id)

    # Upload only stores the file — status="pending" means "uploaded, awaiting
    # a 'Start AI Analysis' job" (see POST /projects/{id}/analysis/start).
    # Analysis no longer auto-triggers here; see services/job_worker.py.
    upload = MediaUpload(
        room_id=room_id,
        supervisor_id=supervisor_id,
        gcs_url=gcs_url,
        gcs_path=gcs_path,
        media_type=media_type_label,
        file_name=file.filename,
        notes=notes,
        status=UploadStatus.pending,
    )
    db.add(upload)
    db.commit()
    db.refresh(upload)

    return upload


async def _run_analysis(
    upload_id: str,
    room_name: str,
    image_bytes: bytes,
    mime: str,
    db: Session,
    project_id: str = None,
):
    """Background task: call Gemini, store result, rollup progress."""
    upload = db.query(MediaUpload).get(upload_id)
    if not upload:
        return

    try:
        # Project's custom Activity Plan (if set) drives which categories Gemini
        # scores — falls back to the default furniture-category list when unset.
        activity_names = None
        if project_id:
            project = db.query(Project).get(project_id)
            if project and project.activity_plan:
                # activity_plan entries are {name, target_date} dicts (older
                # projects may still have plain strings) — only the name
                # feeds the Gemini prompt.
                activity_names = [
                    a["name"] if isinstance(a, dict) else a
                    for a in project.activity_plan
                ]

        # 1. Gemini se response lijiye
        raw_data, overall_pct, notes = await analyse_image(
            image_bytes, mime, room_name, activity_names=activity_names
        )

        # 2. components mein se overall_pct aur notes ko alag kar lijiye 
        # taaki Radar Chart ko sirf saaf-suthra metrics mile
        component_metrics = {
            k: v for k, v in raw_data.items() 
            if v is not None and k not in ["overall_pct", "notes"]
        }

        # 3. Previous analysis check karein change detection ke liye
        prev = (
            db.query(AIAnalysis)
            .filter(AIAnalysis.room_id == upload.room_id)
            .order_by(AIAnalysis.analysed_at.desc())
            .first()
        )
        prev_pct = prev.overall_pct if prev else None
        delta, flag = compute_change_flag(prev_pct, overall_pct)

        # 4. Database mein save karein
        analysis = AIAnalysis(
            room_id=upload.room_id,
            upload_id=upload_id,
            components=component_metrics,  # 🟢 Ab yahan ekdum clean data jayega
            overall_pct=overall_pct,
            ai_notes=notes,
            prev_overall_pct=prev_pct,
            delta_pct=delta,
            change_flag=flag,
        )
        db.add(analysis)
        upload.status = UploadStatus.done
        db.commit()

        full_rollup(upload.room_id, db)

    except Exception as e:
        upload.status = UploadStatus.failed
        db.commit()
        print(f"Error in background analysis: {str(e)}")
        raise

@router.get("/room/{room_id}", response_model=List[UploadOut])
def get_room_uploads(room_id: str, db: Session = Depends(get_db)):
    return (
        db.query(MediaUpload)
        .filter(MediaUpload.room_id == room_id)
        .order_by(MediaUpload.uploaded_at.desc())
        .all()
    )
@router.get("/analysis/room/{room_id}")
def get_latest_room_analysis(room_id: str, db: Session = Depends(get_db)):
    """Frontend is endpoint ko call karke Radar Chart aur AI Notes ka data lega"""
    analysis = (
        db.query(AIAnalysis)
        .filter(AIAnalysis.room_id == room_id)
        .order_by(AIAnalysis.analysed_at.desc())
        .first()
    )
    
    if not analysis:
        raise HTTPException(status_code=404, detail="No AI analysis found for this room")
        
    return {
        "id": analysis.id,
        "room_id": analysis.room_id,
        "upload_id": analysis.upload_id,
        "components": analysis.components,  # Radar chart data
        "overall_pct": analysis.overall_pct,  # Progress percentage
        "ai_notes": analysis.ai_notes,        # AI Notes
        "delta_pct": analysis.delta_pct,
        "change_flag": analysis.change_flag
    }