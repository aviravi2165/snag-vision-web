"""
Site router — backend persistence for Layout Setup, Site Capture and the Panorama viewer.

Projects/floors/rooms here reuse the existing `projects` table (extended with a
`site_floors` JSON column); floor plan images and hotspots get their own tables so
they can be looked up per floor without touching the existing Floor/Unit/Room
hierarchy used by Dashboard/Upload/Analysis.
"""
import uuid
from pathlib import Path
from typing import Optional

import aiofiles
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.orm import Session

from models import get_db
from models.database import (
    FloorPlan, Hotspot, HotspotCapture, MediaUpload, Project, Room, UploadStatus, User,
)
from schemas.models import SiteProjectCreate, HotspotCreate
from routers.auth import get_current_user
from services.gcs_service import upload_media
from services.walkthrough_service import require_capturable

router = APIRouter(prefix="/site", tags=["site"], dependencies=[Depends(get_current_user)])

UPLOAD_DIR = Path("./uploads")
UPLOAD_DIR.mkdir(exist_ok=True)

MAX_SIZE_MB = 20


async def _save_upload(file: UploadFile) -> str:
    """Legacy local-disk write (floor plan images, and hotspots with no real
    Room attached). Captures against a real Room go through
    gcs_service.upload_media() instead — see capture_hotspot below."""
    contents = await file.read()
    return await _save_bytes(contents, file.filename or "")


async def _save_bytes(contents: bytes, filename: str) -> str:
    ext = Path(filename).suffix.lower() or ".jpg"
    name = f"{uuid.uuid4().hex}{ext}"
    dest = UPLOAD_DIR / name
    async with aiofiles.open(dest, "wb") as f:
        await f.write(contents)
    return f"/uploads/{name}"


def _project_out(p: Project) -> dict:
    return {
        "id": p.id,
        "name": p.name,
        "location": p.location,
        "total_floors": p.total_floors,
        "floors": p.site_floors or [],
        "created_at": p.created_at,
    }


def _floor_plan_out(fp: FloorPlan) -> dict:
    return {
        "id": fp.id,
        "project_id": fp.project_id,
        "floor_number": fp.floor_number,
        "image_url": fp.image_url,
        "created_at": fp.created_at,
    }


def _hotspot_out(hs: Hotspot) -> dict:
    return {
        "id": hs.id,
        "project_id": hs.project_id,
        "floor_number": hs.floor_number,
        "x_pct": hs.x_pct,
        "y_pct": hs.y_pct,
        "room_id": hs.room_id,
        "room_name": hs.room_name,
        "created_at": hs.created_at,
    }


def _capture_out(cap: HotspotCapture) -> dict:
    return {
        "id": cap.id,
        "hotspot_id": cap.hotspot_id,
        "image_url": cap.image_url,
        "media_upload_id": cap.media_upload_id,
        "captured_at": cap.captured_at,
    }


# ── Projects ─────────────────────────────────────────────────────────────────

@router.post("/projects", status_code=201)
def create_site_project(data: SiteProjectCreate, db: Session = Depends(get_db)):
    p = Project(
        name=data.name,
        location=data.location,
        total_floors=data.total_floors,
        site_floors=[f.model_dump() for f in data.floors],
    )
    db.add(p)
    db.commit()
    db.refresh(p)
    return _project_out(p)


@router.get("/projects")
def list_site_projects(db: Session = Depends(get_db)):
    return [_project_out(p) for p in db.query(Project).all()]


@router.get("/projects/{project_id}")
def get_site_project(project_id: str, db: Session = Depends(get_db)):
    p = db.query(Project).get(project_id)
    if not p:
        raise HTTPException(404, "Project not found")
    return _project_out(p)


# ── Floor plans ──────────────────────────────────────────────────────────────

@router.post("/projects/{project_id}/floor-plan/{floor_num}", status_code=201)
async def upload_floor_plan(
    project_id: str, floor_num: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    project = db.query(Project).get(project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    url = await _save_upload(file)

    fp = (
        db.query(FloorPlan)
        .filter(FloorPlan.project_id == project_id, FloorPlan.floor_number == floor_num)
        .first()
    )
    if fp:
        fp.image_url = url
    else:
        fp = FloorPlan(project_id=project_id, floor_number=floor_num, image_url=url)
        db.add(fp)
    db.commit()
    db.refresh(fp)
    return _floor_plan_out(fp)


@router.get("/projects/{project_id}/floor-plan/{floor_num}")
def get_floor_plan(project_id: str, floor_num: int, db: Session = Depends(get_db)):
    fp = (
        db.query(FloorPlan)
        .filter(FloorPlan.project_id == project_id, FloorPlan.floor_number == floor_num)
        .first()
    )
    if not fp:
        raise HTTPException(404, "No floor plan for this floor")
    return _floor_plan_out(fp)


# ── Hotspots ─────────────────────────────────────────────────────────────────

@router.post("/projects/{project_id}/hotspots", status_code=201)
def add_hotspot(project_id: str, data: HotspotCreate, db: Session = Depends(get_db)):
    project = db.query(Project).get(project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    hs = Hotspot(project_id=project_id, **data.model_dump())
    db.add(hs)
    db.commit()
    db.refresh(hs)
    return _hotspot_out(hs)


@router.get("/projects/{project_id}/hotspots")
def list_hotspots(project_id: str, floor_number: Optional[int] = None, db: Session = Depends(get_db)):
    q = db.query(Hotspot).filter(Hotspot.project_id == project_id)
    if floor_number is not None:
        q = q.filter(Hotspot.floor_number == floor_number)
    return [_hotspot_out(h) for h in q.all()]


@router.delete("/hotspots/{hotspot_id}", status_code=204)
def delete_hotspot(hotspot_id: str, db: Session = Depends(get_db)):
    hs = db.query(Hotspot).get(hotspot_id)
    if not hs:
        raise HTTPException(404, "Hotspot not found")
    db.query(HotspotCapture).filter(HotspotCapture.hotspot_id == hotspot_id).delete()
    db.delete(hs)
    db.commit()


# ── Hotspot captures ─────────────────────────────────────────────────────────

@router.post("/hotspots/{hotspot_id}/capture", status_code=201)
async def capture_hotspot(
    hotspot_id: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    hs = db.query(Hotspot).get(hotspot_id)
    if not hs:
        raise HTTPException(404, "Hotspot not found")

    # ── Canonical write path (unified media pipeline) ────────────────────────
    # One atomic server-side operation: read the file once, store it via the
    # same gcs_service.upload_media() every other path uses, create the
    # canonical MediaUpload row, then a thin append-only HotspotCapture pointer
    # to it. The upload is stamped into the project's active walkthrough by the
    # same shared gate as the Upload page and mobile app (400 if none).
    room = db.query(Room).get(hs.room_id) if hs.room_id else None
    if room:
        contents = await file.read()
        if len(contents) > MAX_SIZE_MB * 1024 * 1024:
            raise HTTPException(413, f"File too large (max {MAX_SIZE_MB} MB)")

        wt = require_capturable(hs.project_id, db)

        gcs_url, gcs_path = await upload_media(
            contents, file.filename or "capture.jpg", hs.project_id, hs.room_id
        )
        upload = MediaUpload(
            room_id=hs.room_id,
            supervisor_id=user.id,
            gcs_url=gcs_url,
            gcs_path=gcs_path,
            media_type="photo",
            file_name=file.filename,
            notes="Captured via Site Capture",
            status=UploadStatus.pending,
            walkthrough_id=wt.id,
        )
        db.add(upload)
        db.flush()
        cap = HotspotCapture(hotspot_id=hotspot_id, image_url=gcs_url, media_upload_id=upload.id)
        db.add(cap)
        db.commit()
        db.refresh(cap)
        return _capture_out(cap)

    # ── Defensive legacy path ────────────────────────────────────────────────
    # A hotspot with no real Room (Setup blocks saving one, but don't break
    # pre-existing rows): keep the old local-disk HotspotCapture-only write.
    url = await _save_upload(file)
    cap = HotspotCapture(hotspot_id=hotspot_id, image_url=url)
    db.add(cap)
    db.commit()
    db.refresh(cap)
    return _capture_out(cap)


@router.get("/hotspots/{hotspot_id}/capture")
def get_capture(
    hotspot_id: str,
    walkthrough_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """Latest capture for this hotspot — or, with `walkthrough_id`, the capture
    made during that specific walkthrough (read-only past-walkthrough view),
    resolved through the canonical MediaUpload row."""
    q = db.query(HotspotCapture).filter(HotspotCapture.hotspot_id == hotspot_id)
    if walkthrough_id:
        cap = (
            q.join(MediaUpload, HotspotCapture.media_upload_id == MediaUpload.id)
            .filter(MediaUpload.walkthrough_id == walkthrough_id)
            .order_by(HotspotCapture.captured_at.desc())
            .first()
        )
        if not cap:
            raise HTTPException(404, "No capture for this hotspot in this walkthrough")
        return _capture_out(cap)
    cap = q.order_by(HotspotCapture.captured_at.desc()).first()
    if not cap:
        raise HTTPException(404, "No capture for this hotspot")
    return _capture_out(cap)


@router.delete("/hotspots/{hotspot_id}/capture", status_code=204)
def delete_capture(hotspot_id: str, db: Session = Depends(get_db)):
    """Delete the LATEST capture row only — captures are append-only, so
    earlier history stays intact."""
    cap = (
        db.query(HotspotCapture)
        .filter(HotspotCapture.hotspot_id == hotspot_id)
        .order_by(HotspotCapture.captured_at.desc())
        .first()
    )
    if not cap:
        raise HTTPException(404, "No capture for this hotspot")
    db.delete(cap)
    db.commit()
