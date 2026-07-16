"""
Endpoints for the SnagVision mobile app only. Kept separate from the
web-facing routers (auth/projects/uploads) so their existing response shapes
never change for the web frontend — mobile gets its own PascalCase shapes
and its own auth/upload flow here, backed by the same underlying tables.
"""
import mimetypes
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, Header, Form, File, UploadFile, BackgroundTasks
from sqlalchemy.orm import Session, selectinload
from jose import jwt, JWTError

from config import settings
from models import get_db
from models.database import User, Project, Floor, Room, Spot, FloorPlan, Hotspot, MediaUpload, UploadStatus, UserRole
from schemas.models import LoginIn, MobileSpotCreate, UserCreate
from routers.auth import verify_pw, hash_pw, create_token, ALGORITHM
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


def get_current_mobile_user(user_id: str = Depends(get_current_user_id), db: Session = Depends(get_db)) -> User:
    user = db.query(User).get(user_id)
    if not user:
        raise HTTPException(401, "User not found")
    return user


def require_mobile_role(*roles: UserRole):
    """Only the spot create/delete endpoints use this today — matches the
    original spec ('only admin or manager can add/remove a spot'). Every
    other /mobile/* endpoint stays open to any logged-in role, same as
    before, so existing app flows for a site_supervisor account are
    unaffected."""
    def _check(user: User = Depends(get_current_mobile_user)) -> User:
        if user.role not in roles:
            raise HTTPException(403, "Not permitted for this role")
        return user
    return _check


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


@router.post("/auth/register")
def mobile_register(data: UserCreate, db: Session = Depends(get_db)):
    if db.query(User).filter(User.email == data.email).first():
        raise HTTPException(400, "Email already registered")
    user = User(
        name=data.name,
        email=data.email,
        hashed_password=hash_pw(data.password),
        role=data.role,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return {
        "token": create_token(user.id),
        "user": {"id": user.id, "name": user.name, "email": user.email, "role": user.role.value},
    }


# ── Projects / structure ─────────────────────────────────────────────────────

@router.get("/projects")
def mobile_projects(db: Session = Depends(get_db), user_id: str = Depends(get_current_user_id)):
    # selectinload batches every project's floors into one extra query
    # instead of one query per project (len(p.floors) below would otherwise
    # lazy-load each project's floors individually).
    projects = db.query(Project).options(selectinload(Project.floors)).all()
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


def _sync_hotspots_to_spots(db: Session, floor: Floor, hotspots: list[Hotspot]):
    """Materializes the web Layout Setup's hotspots as real Spot rows so the
    app can show and capture photos against whatever was built there,
    without the app or the photo-upload FK requirements needing to know
    hotspots exist at all. Idempotent — re-run on every structure read,
    keyed by client_spot_id = 'hotspot:<hotspot.id>' so repeat reads update
    (not duplicate) the same Spot, and a deleted hotspot's Spot is pruned."""
    room = db.query(Room).filter(Room.floor_id == floor.id).first()
    if not room:
        room = Room(floor_id=floor.id, name="Layout")
        db.add(room)
        db.commit()
        db.refresh(room)

    current_keys = {f"hotspot:{hs.id}" for hs in hotspots}
    materialized = db.query(Spot).filter(
        Spot.room_id == room.id, Spot.client_spot_id.like("hotspot:%")
    ).all()
    for s in materialized:
        if s.client_spot_id not in current_keys:
            db.delete(s)

    for idx, hs in enumerate(hotspots, start=1):
        key = f"hotspot:{hs.id}"
        name = hs.room_name or f"Spot {idx}"
        spot = db.query(Spot).filter(Spot.client_spot_id == key).first()
        if spot:
            spot.coordinate_x, spot.coordinate_y = hs.x_pct, hs.y_pct
            spot.name, spot.sort_order = name, idx
        else:
            db.add(Spot(
                room_id=room.id, name=name,
                coordinate_x=hs.x_pct, coordinate_y=hs.y_pct,
                sort_order=idx, client_spot_id=key,
            ))
    db.commit()


@router.get("/projects/{project_id}/structure")
def mobile_structure(project_id: str, db: Session = Depends(get_db), user_id: str = Depends(get_current_user_id)):
    project = db.query(Project).get(project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    floors = sorted(project.floors, key=lambda f: f.floor_number)
    floor_ids = [f.id for f in floors]

    # Batch-fetch everything for the whole project up front instead of
    # querying per floor and per room — this endpoint used to run roughly
    # 1 + 4*floors + rooms queries (measured ~356ms avg on a real 10-floor/
    # 40-room/240-spot project); it's now a fixed handful of queries
    # regardless of project size.
    floor_plans_by_num = {
        fp.floor_number: fp
        for fp in db.query(FloorPlan).filter(FloorPlan.project_id == project_id).all()
    }
    hotspots_by_num = {}
    for hs in (
        db.query(Hotspot).filter(Hotspot.project_id == project_id).order_by(Hotspot.created_at).all()
    ):
        hotspots_by_num.setdefault(hs.floor_number, []).append(hs)

    def _fetch_rooms_and_spots():
        rooms = db.query(Room).filter(Room.floor_id.in_(floor_ids)).all() if floor_ids else []
        by_floor = {}
        for r in rooms:
            by_floor.setdefault(r.floor_id, []).append(r)
        room_ids = [r.id for r in rooms]
        spots = db.query(Spot).filter(Spot.room_id.in_(room_ids)).order_by(Spot.sort_order).all() if room_ids else []
        by_room = {}
        for s in spots:
            by_room.setdefault(s.room_id, []).append(s)
        return by_floor, by_room, spots

    rooms_by_floor, spots_by_room, all_spots = _fetch_rooms_and_spots()

    # Only floors with a live hotspot, or a previously hotspot-materialized
    # spot that might now need pruning, actually need _sync_hotspots_to_spots
    # — for a project with no Layout Setup activity at all (the common
    # case) this correctly ends up empty and skips the sync/re-fetch below
    # entirely.
    hotspot_room_ids = {s.room_id for s in all_spots if (s.client_spot_id or "").startswith("hotspot:")}
    needs_sync = [
        f for f in floors
        if hotspots_by_num.get(f.floor_number)
        or any(r.id in hotspot_room_ids for r in rooms_by_floor.get(f.id, []))
    ]
    if needs_sync:
        for floor in needs_sync:
            _sync_hotspots_to_spots(db, floor, hotspots_by_num.get(floor.floor_number, []))
        rooms_by_floor, spots_by_room, all_spots = _fetch_rooms_and_spots()

    out = []
    for floor in floors:
        floor_plan = floor_plans_by_num.get(floor.floor_number)
        plan_image_url = (floor_plan.image_url if floor_plan else None) or floor.plan_image_url

        rooms_out = []
        for room in rooms_by_floor.get(floor.id, []):
            spots_out = [
                {
                    "SpotId": s.id,
                    "SpotName": s.name,
                    "RoomId": room.id,
                    "CoordinateX": s.coordinate_x,
                    "CoordinateY": s.coordinate_y,
                    "SortOrder": s.sort_order,
                }
                for s in spots_by_room.get(room.id, [])
            ]
            rooms_out.append({"RoomId": room.id, "RoomName": room.name, "ColorHex": None, "spots": spots_out})
        out.append({
            "FloorId": floor.id,
            "FloorName": floor.label or f"Floor {floor.floor_number}",
            "FloorPlanImageUrl": plan_image_url,
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


# ── Spots (offline-first create/delete) ────────────────────────────────────

def _spot_out(spot: Spot):
    return {
        "SpotId": spot.id,
        "SpotName": spot.name,
        "RoomId": spot.room_id,
        "CoordinateX": spot.coordinate_x,
        "CoordinateY": spot.coordinate_y,
        "SortOrder": spot.sort_order,
    }


@router.post("/spots")
def create_spot_mobile(
    data: MobileSpotCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_mobile_role(UserRole.admin, UserRole.project_manager)),
):
    # Idempotency: a retried sync re-sends the same clientSpotId — return the
    # already-landed record instead of creating a duplicate.
    existing = db.query(Spot).filter(Spot.client_spot_id == data.clientSpotId).first()
    if existing:
        return _spot_out(existing)

    room = db.query(Room).get(data.roomId)
    if not room:
        raise HTTPException(404, "Room not found")

    spot = Spot(
        room_id=data.roomId,
        name=data.name,
        coordinate_x=data.coordinateX,
        coordinate_y=data.coordinateY,
        sort_order=data.sortOrder,
        client_spot_id=data.clientSpotId,
    )
    db.add(spot)
    db.commit()
    db.refresh(spot)
    return _spot_out(spot)


@router.delete("/spots/{spot_id}", status_code=204)
def delete_spot_mobile(
    spot_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_mobile_role(UserRole.admin, UserRole.project_manager)),
):
    # Unlike routers/projects.py's delete_spot, missing/already-deleted is
    # treated as success — a retried sync delete after an interrupted
    # response must not be logged as a failure and retried forever.
    spot = db.query(Spot).get(spot_id)
    if spot:
        db.delete(spot)
        db.commit()
    return
