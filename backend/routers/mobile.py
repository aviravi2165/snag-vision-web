"""
Endpoints for the SnagVision mobile app only. Kept separate from the
web-facing routers (auth/projects/uploads) so their existing response shapes
never change for the web frontend — mobile gets its own PascalCase shapes
and its own auth/upload flow here, backed by the same underlying tables.
"""
import mimetypes
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, Header, Form, File, UploadFile, BackgroundTasks
from sqlalchemy.orm import Session
from jose import jwt, JWTError

from config import settings
from models import get_db
from models.database import User, Project, Room, Spot, MediaUpload, UploadStatus
from schemas.models import LoginIn
from routers.auth import verify_pw, create_token, ALGORITHM
from routers.uploads import _run_analysis
from services.gcs_service import upload_media

router = APIRouter(prefix="/mobile", tags=["mobile"])

MAX_SIZE_MB = 20


def get_current_user_id(authorization: str = Header(None)) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing bearer token")
    token = authorization.removeprefix("Bearer ").strip()
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        raise HTTPException(401, "Invalid or expired token")
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(401, "Invalid token")
    return user_id


# ── Auth ─────────────────────────────────────────────────────────────────────

@router.post("/auth/login")
def mobile_login(data: LoginIn, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == data.email).first()
    if not user or not verify_pw(data.password, user.hashed_password):
        raise HTTPException(401, "Invalid credentials")
    return {
        "token": create_token(user.id),
        "user": {"id": user.id, "name": user.name, "email": user.email, "role": user.role.value},
    }


# ── Projects / structure ─────────────────────────────────────────────────────

@router.get("/projects")
def mobile_projects(db: Session = Depends(get_db), user_id: str = Depends(get_current_user_id)):
    projects = db.query(Project).all()
    return [
        {
            "ProjectId": p.id,
            "Name": p.name,
            "Folder": p.folder or "IEVO",
            "City": p.city or (p.location or ""),
            "FloorCount": len(p.floors),
        }
        for p in projects
    ]


@router.get("/projects/{project_id}/structure")
def mobile_structure(project_id: str, db: Session = Depends(get_db), user_id: str = Depends(get_current_user_id)):
    project = db.query(Project).get(project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    out = []
    for floor in sorted(project.floors, key=lambda f: f.floor_number):
        rooms_out = []
        for room in floor.rooms:
            spots_out = [
                {
                    "SpotId": s.id,
                    "SpotName": s.name,
                    "RoomId": room.id,
                    "CoordinateX": s.coordinate_x,
                    "CoordinateY": s.coordinate_y,
                    "SortOrder": s.sort_order,
                }
                for s in sorted(room.spots, key=lambda s: s.sort_order)
            ]
            rooms_out.append({"RoomId": room.id, "RoomName": room.name, "ColorHex": None, "spots": spots_out})
        out.append({
            "FloorId": floor.id,
            "FloorName": floor.label or f"Floor {floor.floor_number}",
            "FloorPlanImageUrl": floor.plan_image_url,
            "rooms": rooms_out,
        })
    return out


# ── Uploads ───────────────────────────────────────────────────────────────────

@router.post("/uploads/photo")
async def upload_photo(
    background_tasks: BackgroundTasks,
    photoId: str = Form(...),
    projectId: str = Form(...),
    roomId: str = Form(...),
    spotId: str = Form(""),
    checksum: str = Form(""),
    image: UploadFile = File(...),
    db: Session = Depends(get_db),
    user_id: str = Depends(get_current_user_id),
):
    # Idempotency: a retried sync re-sends the same photoId — return the
    # already-landed record instead of creating a duplicate.
    existing = db.query(MediaUpload).filter(MediaUpload.client_photo_id == photoId).first()
    if existing:
        return {"id": existing.id, "status": existing.status.value}

    room = db.query(Room).get(roomId)
    if not room:
        raise HTTPException(404, "Room not found")

    contents = await image.read()
    if len(contents) > MAX_SIZE_MB * 1024 * 1024:
        raise HTTPException(413, f"File too large (max {MAX_SIZE_MB} MB)")

    mime = image.content_type or mimetypes.guess_type(image.filename or "")[0] or "image/jpeg"
    gcs_url, gcs_path = await upload_media(contents, image.filename or f"{photoId}.jpg", projectId, roomId)

    upload = MediaUpload(
        room_id=roomId,
        spot_id=spotId or None,
        supervisor_id=user_id,
        gcs_url=gcs_url,
        gcs_path=gcs_path,
        media_type="photo",
        file_name=image.filename,
        notes=f"checksum:{checksum}" if checksum else None,
        status=UploadStatus.analysing,
        client_photo_id=photoId,
    )
    db.add(upload)
    db.commit()
    db.refresh(upload)

    if "image" in mime:
        background_tasks.add_task(_run_analysis, upload.id, room.name, contents, mime, db)

    return {"id": upload.id, "status": upload.status.value}


@router.get("/uploads/status")
def uploads_status(ids: str, db: Session = Depends(get_db), user_id: str = Depends(get_current_user_id)):
    """Batch idempotency check — lets the mobile sync engine confirm what
    already landed on the server before re-uploading after an interrupted sync."""
    id_list = [i for i in ids.split(",") if i]
    rows = db.query(MediaUpload).filter(MediaUpload.client_photo_id.in_(id_list)).all()
    found = {r.client_photo_id: {"id": r.id, "status": r.status.value} for r in rows}
    return [{"photoId": i, **(found.get(i) or {"id": None, "status": "not_found"})} for i in id_list]
