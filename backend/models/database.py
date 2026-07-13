from sqlalchemy import (
    Column, String, Integer, Float, DateTime, ForeignKey,
    Text, Enum, JSON, Boolean, create_engine
)
from sqlalchemy.orm import declarative_base, relationship
from sqlalchemy.dialects.postgresql import UUID
from datetime import datetime
import uuid
import enum

Base = declarative_base()


def gen_uuid():    
    return str(uuid.uuid4())


class UserRole(str, enum.Enum):
    admin = "admin"
    project_manager = "project_manager"
    site_supervisor = "site_supervisor"
    client = "client"


class UploadStatus(str, enum.Enum):
    pending = "pending"
    analysing = "analysing"
    done = "done"
    failed = "failed"


class User(Base):
    __tablename__ = "users"
    id = Column(String(36), primary_key=True, default=gen_uuid)
    name = Column(String(255), nullable=False)
    email = Column(String(255), unique=True, nullable=False)
    hashed_password = Column(String(255), nullable=False)
    role = Column(Enum(UserRole), default=UserRole.site_supervisor)
    created_at = Column(DateTime, default=datetime.utcnow)
    uploads = relationship("MediaUpload", back_populates="supervisor")


class Project(Base):
    __tablename__ = "projects"
    id = Column(String(36), primary_key=True, default=gen_uuid)
    name = Column(String(255), nullable=False)
    location = Column(String)
    total_floors = Column(Integer, default=1)
    planned_completion = Column(DateTime)
    created_at = Column(DateTime, default=datetime.utcnow)
    # Mobile-only display fields (Folder/City shown on the Projects screen) — nullable
    # so existing web-created projects don't need backfilling.
    folder = Column(String(255), nullable=True)
    city = Column(String(255), nullable=True)
    floors = relationship("Floor", back_populates="project", cascade="all, delete")
    milestones = relationship("Milestone", back_populates="project", cascade="all, delete")
    estimated_completion_date = Column(DateTime, nullable=True)
    # Lightweight floor/room list for the Site (Layout Setup) subsystem — [{number, rooms:[{id,name}]}].
    # Named site_floors (not "floors") because that name is already the Floor relationship above.
    site_floors = Column(JSON, nullable=True)

class Floor(Base):
    __tablename__ = "floors"
    id = Column(String(36), primary_key=True, default=gen_uuid)
    project_id = Column(String(36), ForeignKey("projects.id"), nullable=False)
    floor_number = Column(Integer, nullable=False)
    label = Column(String)
    progress_pct = Column(Float, default=0.0)
    # Floor-plan image the mobile Capture screen displays and pins spots onto.
    plan_image_url = Column(String(500), nullable=True)
    project = relationship("Project", back_populates="floors")
    units = relationship("Unit", back_populates="floor", cascade="all, delete")
    # Mobile-created rooms can hang directly off a floor (no Unit layer needed
    # for a simple hotel-room/site-room capture flow) — see Room.floor_id.
    rooms = relationship("Room", back_populates="floor", cascade="all, delete")


class Unit(Base):
    __tablename__ = "units"
    id = Column(String(36), primary_key=True, default=gen_uuid)
    floor_id = Column(String(36), ForeignKey("floors.id"), nullable=False)
    unit_number = Column(String(255), nullable=False)
    progress_pct = Column(Float, default=0.0)
    floor = relationship("Floor", back_populates="units")
    rooms = relationship("Room", back_populates="unit", cascade="all, delete")


class Room(Base):
    __tablename__ = "rooms"
    id = Column(String(36), primary_key=True, default=gen_uuid)
    # Nullable now: a web-created Room hangs off a Unit; a mobile-created Room
    # (see floor_id below) hangs directly off a Floor — exactly one is set.
    unit_id = Column(String(36), ForeignKey("units.id"), nullable=True)
    floor_id = Column(String(36), ForeignKey("floors.id"), nullable=True)
    name = Column(String(255), nullable=False)
    progress_pct = Column(Float, default=0.0)
    last_analysed = Column(DateTime)
    unit = relationship("Unit", back_populates="rooms")
    floor = relationship("Floor", back_populates="rooms")
    uploads = relationship("MediaUpload", back_populates="room")
    analyses = relationship("AIAnalysis", back_populates="room", cascade="all, delete")
    spots = relationship("Spot", back_populates="room", cascade="all, delete")


class MediaUpload(Base):
    __tablename__ = "media_uploads"
    id = Column(String(36), primary_key=True, default=gen_uuid)
    room_id = Column(String(36), ForeignKey("rooms.id"), nullable=False)
    supervisor_id = Column(String(36), ForeignKey("users.id"), nullable=False)
    gcs_url = Column(String(255), nullable=False)
    gcs_path = Column(String(255), nullable=False)
    media_type = Column(String)  # photo / video / 360
    file_name = Column(String)
    notes = Column(Text)
    status = Column(Enum(UploadStatus), default=UploadStatus.pending)
    uploaded_at = Column(DateTime, default=datetime.utcnow)
    # The mobile app's local queue id — lets a retried upload find (and return)
    # the record that already landed instead of creating a duplicate.
    client_photo_id = Column(String(64), nullable=True, unique=True, index=True)
    spot_id = Column(String(36), ForeignKey("spots.id"), nullable=True)
    room = relationship("Room", back_populates="uploads")
    supervisor = relationship("User", back_populates="uploads")
    analysis = relationship("AIAnalysis", back_populates="upload", uselist=False)


class Spot(Base):
    """A tappable pin on a floor-plan image — the mobile app's capture unit."""
    __tablename__ = "spots"
    id = Column(String(36), primary_key=True, default=gen_uuid)
    room_id = Column(String(36), ForeignKey("rooms.id"), nullable=False)
    name = Column(String(255), nullable=False)
    coordinate_x = Column(Float, nullable=False)  # normalized 0..1, relative to the floor plan image
    coordinate_y = Column(Float, nullable=False)
    sort_order = Column(Integer, default=1)
    # The mobile app's local queue id — lets a retried offline-sync create
    # find (and return) the record that already landed instead of creating
    # a duplicate. Mirrors MediaUpload.client_photo_id's pattern.
    client_spot_id = Column(String(64), nullable=True, unique=True, index=True)
    room = relationship("Room", back_populates="spots")


class AIAnalysis(Base):
    __tablename__ = "ai_analyses"
    id = Column(String(36), primary_key=True, default=gen_uuid)
    room_id = Column(String(36), ForeignKey("rooms.id"), nullable=False)
    upload_id = Column(String(36), ForeignKey("media_uploads.id"), nullable=False)
    # Component-level progress (JSON dict)
    components = Column(JSON)   # {"flooring": 90, "painting": 80, ...}
    overall_pct = Column(Float)
    ai_notes = Column(Text)
    prev_overall_pct = Column(Float)   # for change detection
    delta_pct = Column(Float)
    change_flag = Column(String)        # progress / stalled / rework
    analysed_at = Column(DateTime, default=datetime.utcnow)
    room = relationship("Room", back_populates="analyses")
    upload = relationship("MediaUpload", back_populates="analysis")


class Milestone(Base):
    __tablename__ = "milestones"
    id = Column(String(36), primary_key=True, default=gen_uuid)
    project_id = Column(String(36), ForeignKey("projects.id"), nullable=False)
    label = Column(String(255), nullable=False)
    target_pct = Column(Float)
    target_date = Column(DateTime)
    achieved = Column(Boolean, default=False)
    project = relationship("Project", back_populates="milestones")


class FloorPlan(Base):
    __tablename__ = "floor_plans"
    id = Column(String(36), primary_key=True, default=gen_uuid)
    project_id = Column(String(36), ForeignKey("projects.id"), nullable=False)
    floor_number = Column(Integer, nullable=False)
    image_url = Column(String(500), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)


class Hotspot(Base):
    __tablename__ = "hotspots"
    id = Column(String(36), primary_key=True, default=gen_uuid)
    project_id = Column(String(36), ForeignKey("projects.id"), nullable=False)
    floor_number = Column(Integer, nullable=False)
    x_pct = Column(Float, nullable=False)
    y_pct = Column(Float, nullable=False)
    room_id = Column(String(255))
    room_name = Column(String(255))
    created_at = Column(DateTime, default=datetime.utcnow)


class HotspotCapture(Base):
    __tablename__ = "hotspot_captures"
    id = Column(String(36), primary_key=True, default=gen_uuid)
    hotspot_id = Column(String(36), ForeignKey("hotspots.id"), nullable=False)
    image_url = Column(String(500))
    captured_at = Column(DateTime, default=datetime.utcnow)
