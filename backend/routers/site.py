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
from models.database import Project, FloorPlan, Hotspot, HotspotCapture
from schemas.models import SiteProjectCreate, HotspotCreate

router = APIRouter(prefix="/site", tags=["site"])

UPLOAD_DIR = Path("./uploads")
UPLOAD_DIR.mkdir(exist_ok=True)


async def _save_upload(file: UploadFile) -> str:
    ext = Path(file.filename or "").suffix.lower() or ".jpg"
    name = f"{uuid.uuid4().hex}{ext}"
    dest = UPLOAD_DIR / name
    contents = await file.read()
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
async def capture_hotspot(hotspot_id: str, file: UploadFile = File(...), db: Session = Depends(get_db)):
    hs = db.query(Hotspot).get(hotspot_id)
    if not hs:
        raise HTTPException(404, "Hotspot not found")

    url = await _save_upload(file)

    cap = db.query(HotspotCapture).filter(HotspotCapture.hotspot_id == hotspot_id).first()
    if cap:
        cap.image_url = url
    else:
        cap = HotspotCapture(hotspot_id=hotspot_id, image_url=url)
        db.add(cap)
    db.commit()
    db.refresh(cap)
    return _capture_out(cap)


@router.get("/hotspots/{hotspot_id}/capture")
def get_capture(hotspot_id: str, db: Session = Depends(get_db)):
    cap = db.query(HotspotCapture).filter(HotspotCapture.hotspot_id == hotspot_id).first()
    if not cap:
        raise HTTPException(404, "No capture for this hotspot")
    return _capture_out(cap)


@router.delete("/hotspots/{hotspot_id}/capture", status_code=204)
def delete_capture(hotspot_id: str, db: Session = Depends(get_db)):
    cap = db.query(HotspotCapture).filter(HotspotCapture.hotspot_id == hotspot_id).first()
    if not cap:
        raise HTTPException(404, "No capture for this hotspot")
    db.delete(cap)
    db.commit()
