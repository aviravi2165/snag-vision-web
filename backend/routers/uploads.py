from fastapi import APIRouter, Depends, UploadFile, File, Form, HTTPException
from sqlalchemy.orm import Session
from models import get_db
from models.database import (
    AIAnalysis, CaptureSession, Floor, MediaUpload, Project, Room, Spot, Unit, UploadStatus,
)
from schemas.models import ProjectMediaOut, UploadOut
from services.gcs_service import upload_media
from services.gemini_service import analyse_image, compute_change_flag
from services.progress_service import full_rollup
from services.walkthrough_service import project_room_ids, require_capturable
from routers.walkthroughs import _walkthrough_out
from routers.auth import get_current_user
from typing import List
import mimetypes

router = APIRouter(prefix="/uploads", tags=["uploads"], dependencies=[Depends(get_current_user)])

IMAGE_MIMES = {"image/jpeg", "image/png", "image/webp"}
MAX_SIZE_MB = 20


class _UploadLabels:
    """Bulk label resolver for the Media Manager — loads Floor/Unit/Room/Spot
    once per request instead of per row (same pattern as routers/issues.py's
    _LocationLabels), so the project-wide listing stays N+1-free as media
    volume grows."""

    def __init__(self, uploads: List[MediaUpload], db: Session):
        room_ids = {u.room_id for u in uploads}
        spot_ids = {u.spot_id for u in uploads if u.spot_id}
        rooms = db.query(Room).filter(Room.id.in_(room_ids)).all() if room_ids else []
        self.rooms = {r.id: r for r in rooms}
        unit_ids = {r.unit_id for r in rooms if r.unit_id}
        flat_floor_ids = {r.floor_id for r in rooms if r.floor_id}
        units = db.query(Unit).filter(Unit.id.in_(unit_ids)).all() if unit_ids else []
        self.units = {u.id: u for u in units}
        floor_ids = flat_floor_ids | {u.floor_id for u in units}
        floors = db.query(Floor).filter(Floor.id.in_(floor_ids)).all() if floor_ids else []
        self.floors = {f.id: f for f in floors}
        self.spots = {
            s.id: s.name
            for s in (db.query(Spot).filter(Spot.id.in_(spot_ids)).all() if spot_ids else [])
        }

    def apply(self, u: MediaUpload) -> dict:
        room = self.rooms.get(u.room_id)
        floor_number, parent_label, location_label = None, None, (room.name if room else None)
        if room:
            if room.floor_id:   # mobile-style flat Room (Floor -> Room)
                floor = self.floors.get(room.floor_id)
                floor_number = floor.floor_number if floor else None
                parent_label = room.name
            elif room.unit_id:  # web-style Room ID -> Unit, Room = Area
                unit = self.units.get(room.unit_id)
                floor = self.floors.get(unit.floor_id) if unit else None
                floor_number = floor.floor_number if floor else None
                parent_label = unit.unit_number if unit else None
        if u.spot_id and u.spot_id in self.spots:
            location_label = self.spots[u.spot_id]
        return {
            "floor_number": floor_number,
            "parent_label": parent_label,
            "location_label": location_label,
        }


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

    # Derive project_id from the room hierarchy (web: Unit -> Floor; mobile:
    # flat Room -> Floor).
    project_id = None
    if room.unit and room.unit.floor:
        project_id = room.unit.floor.project_id
    elif room.floor:
        project_id = room.floor.project_id
    if not project_id:
        raise HTTPException(400, "Room is not linked to a project")

    # One shared gate with Site Capture and the mobile app: uploads only land
    # in an active walkthrough (400 "Start a walkthrough first" otherwise).
    wt = require_capturable(project_id, db)

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
        walkthrough_id=wt.id,
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


@router.get("/project/{project_id}", response_model=ProjectMediaOut)
def get_project_uploads(project_id: str, db: Session = Depends(get_db)):
    """Media Manager — every capture for the project, grouped by walkthrough
    (newest first), each group carrying its summary row (Total / Pending AI /
    Done / Failed). Pre-walkthrough-era rows (walkthrough_id NULL) land in a
    "Legacy" group so existing data stays visible. One query for the media
    rows + one query per label table + one query for walkthroughs — no
    per-row round-trips."""
    if not db.query(Project).get(project_id):
        raise HTTPException(404, "Project not found")

    room_ids = project_room_ids(project_id, db)
    uploads = (
        db.query(MediaUpload)
        .filter(MediaUpload.room_id.in_(room_ids))
        .order_by(MediaUpload.uploaded_at.desc())
        .all()
        if room_ids
        else []
    )
    labels = _UploadLabels(uploads, db)

    walkthroughs = (
        db.query(CaptureSession)
        .filter(CaptureSession.project_id == project_id)
        .order_by(CaptureSession.number.desc())
        .all()
    )

    def _media_out(u: MediaUpload) -> dict:
        return {
            "id": u.id,
            "file_name": u.file_name,
            "gcs_url": u.gcs_url,
            "media_type": u.media_type,
            "status": u.status.value,
            "uploaded_at": u.uploaded_at,
            "notes": u.notes,
            "room_id": u.room_id,
            "spot_id": u.spot_id,
            "walkthrough_id": u.walkthrough_id,
            **labels.apply(u),
        }

    def _group_out(wt, rows):
        # Summary derived in one pass over the group's rows (already fetched
        # once above) — no extra aggregate queries.
        total = len(rows)
        pending = sum(1 for u in rows if u.status == UploadStatus.pending)
        done = sum(1 for u in rows if u.status == UploadStatus.done)
        failed = sum(1 for u in rows if u.status == UploadStatus.failed)
        return {
            "walkthrough": _walkthrough_out(wt, db) if wt else None,
            "label": f"Walkthrough {wt.number}" if wt else "Legacy (pre-walkthrough)",
            "summary": {"total": total, "pending": pending, "done": done, "failed": failed},
            "media": [_media_out(u) for u in rows],
        }

    groups = []
    for wt in walkthroughs:
        rows = [u for u in uploads if u.walkthrough_id == wt.id]
        if rows:
            groups.append(_group_out(wt, rows))
    legacy = [u for u in uploads if u.walkthrough_id is None]
    if legacy:
        groups.append(_group_out(None, legacy))
    return ProjectMediaOut(project_id=project_id, groups=groups)
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