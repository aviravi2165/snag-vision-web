"""
Dev-only seed data so the mobile app has something real to talk to on first
boot: the default demo worker account it already hardcodes, and one demo
project with a floor plan + spots so Capture/Dashboard aren't empty.
Idempotent — safe to run on every startup.
"""
from pathlib import Path
from sqlalchemy.orm import Session
from models.database import User, UserRole, Project, Floor, Room, Spot
from routers.auth import hash_pw

DEMO_EMAIL = "field@snagvision.io"
DEMO_PASSWORD = "Password@123"

UPLOADS_DIR = Path("./uploads")
PLAN_IMAGE_NAME = "seed-floor-plan.png"


def _ensure_placeholder_plan_image():
    """Generates a tiny local floor-plan placeholder so the mobile app can
    load it over LAN without needing any internet access (unlike the old
    placehold.co mock URL)."""
    path = UPLOADS_DIR / PLAN_IMAGE_NAME
    if path.exists():
        return
    UPLOADS_DIR.mkdir(exist_ok=True)
    from PIL import Image, ImageDraw
    img = Image.new("RGB", (900, 600), color=(22, 24, 29))
    d = ImageDraw.Draw(img)
    d.rectangle([20, 20, 880, 580], outline=(217, 41, 6), width=4)
    d.text((380, 290), "Floor Plan", fill=(255, 255, 255))
    img.save(path)


def seed_demo_data(db: Session):
    if not db.query(User).filter(User.email == DEMO_EMAIL).first():
        db.add(User(
            name="Field Worker",
            email=DEMO_EMAIL,
            hashed_password=hash_pw(DEMO_PASSWORD),
            role=UserRole.site_supervisor,
        ))
        db.commit()

    if db.query(Project).count() > 0:
        return

    _ensure_placeholder_plan_image()

    project = Project(
        name="Courtyard by Marriott — Bharuch",
        location="Bharuch",
        folder="IEVO",
        city="Bharuch",
        total_floors=1,
    )
    db.add(project)
    db.commit()
    db.refresh(project)

    floor = Floor(
        project_id=project.id,
        floor_number=1,
        label="Ground Floor",
        plan_image_url=f"/uploads/{PLAN_IMAGE_NAME}",
    )
    db.add(floor)
    db.commit()
    db.refresh(floor)

    room = Room(floor_id=floor.id, name="Lobby")
    db.add(room)
    db.commit()
    db.refresh(room)

    for i, (x, y) in enumerate([(0.25, 0.3), (0.5, 0.45), (0.7, 0.6)], start=1):
        db.add(Spot(room_id=room.id, name=f"Spot {i}", coordinate_x=x, coordinate_y=y, sort_order=i))
    db.commit()
