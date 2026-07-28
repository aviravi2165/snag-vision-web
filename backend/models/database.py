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


class AnalysisJobStatus(str, enum.Enum):
    pending = "pending"
    running = "running"
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
    # Legacy Activity Plan (list of {name, target_date} dicts, or plain strings on
    # very old projects). Superseded by the `Activity` table below — kept read-only
    # for backward compat; ensure_activities_from_legacy_plan() one-time-copies it
    # into real Activity rows the first time a project's activities are requested.
    activity_plan = Column(JSON, nullable=True)
    # Components scoring below this (0..1) are excluded from activity-progress
    # aggregation — see services/mapping_service.py:recompute_unit_activity_progress().
    confidence_threshold = Column(Float, nullable=True, default=0.5)
    activities = relationship("Activity", back_populates="project", cascade="all, delete")

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
    uploads = relationship("MediaUpload", back_populates="room", cascade="all, delete")
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
    # Which AnalysisJob processed this upload — set when a "Start AI Analysis" job
    # picks it up. Null while status="pending" (uploaded, awaiting a job).
    job_id = Column(String(36), ForeignKey("analysis_jobs.id"), nullable=True)
    room = relationship("Room", back_populates="uploads")
    supervisor = relationship("User", back_populates="uploads")
    analysis = relationship("AIAnalysis", back_populates="upload", uselist=False, cascade="all, delete")


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
    # NOT unique=True here deliberately — most spots (created via the plain
    # web form) never set this, and MSSQL's plain unique index only allows
    # ONE null total (unlike Postgres/SQLite). Uniqueness among the rows
    # that DO set it is enforced instead by a filtered index, set up in
    # models/__init__.py's _ensure_indexes(), which allows unlimited nulls.
    client_spot_id = Column(String(64), nullable=True, index=True)
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


# ═══════════════════════════════════════════════════════════════════════════
# Dynamic Activity-Excel-driven progress tracking
# (Activity Excel upload → AI component/activity mapping → per-room-per-activity
# progress, kept in sync with the physical uploaded .xlsx). See
# services/excel_service.py, services/mapping_service.py, services/job_worker.py.
# ═══════════════════════════════════════════════════════════════════════════

class Activity(Base):
    """One row per activity, exactly as written in the project's Activity Excel —
    name is never mutated/standardized. Replaces Project.activity_plan (JSON) as
    the source of truth for new projects; existing JSON is migrated in lazily."""
    __tablename__ = "activities"
    id = Column(String(36), primary_key=True, default=gen_uuid)
    project_id = Column(String(36), ForeignKey("projects.id"), nullable=False)
    name = Column(String(255), nullable=False)
    start_date = Column(DateTime, nullable=True)
    end_date = Column(DateTime, nullable=True)
    sort_order = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)
    project = relationship("Project", back_populates="activities")
    mappings = relationship("ActivityMapping", back_populates="activity", cascade="all, delete")
    unit_progress = relationship("UnitActivityProgress", back_populates="activity", cascade="all, delete")


class ActivityMapping(Base):
    """component_key (Gemini's open-vocabulary detection, e.g. "marble") -> activity.
    One project's mapping never affects another's — nothing here is hardcoded
    across projects. source distinguishes an AI-proposed row from a manual edit."""
    __tablename__ = "activity_mappings"
    id = Column(String(36), primary_key=True, default=gen_uuid)
    project_id = Column(String(36), ForeignKey("projects.id"), nullable=False)
    component_key = Column(String(100), nullable=False)
    activity_id = Column(String(36), ForeignKey("activities.id"), nullable=False)
    confidence = Column(Float, default=1.0)
    source = Column(String(20), default="ai")  # ai | manual
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    activity = relationship("Activity", back_populates="mappings")


class UnmappedComponent(Base):
    """A component Gemini detected with no ActivityMapping row yet for this
    project — logged instead of silently dropped or guessed, so it can be
    manually mapped later (or left out on purpose)."""
    __tablename__ = "unmapped_components"
    id = Column(String(36), primary_key=True, default=gen_uuid)
    project_id = Column(String(36), ForeignKey("projects.id"), nullable=False)
    component_key = Column(String(100), nullable=False)
    sample_count = Column(Integer, default=1)
    first_seen = Column(DateTime, default=datetime.utcnow)
    last_seen = Column(DateTime, default=datetime.utcnow)


class UnitActivityProgress(Base):
    """The aggregated, queryable (Unit, Activity) progress cell — a Unit (e.g.
    "A-101", the Room ID in the business sense — the Activity Excel's actual
    column granularity) combined-averages across its own Areas (the Room
    table — e.g. Living/Bathroom). Area-level breakdown stays Floor View's
    job (Room.progress_pct via the existing room->unit->floor rollup); this
    table is what the Activity Excel and the new Executive dashboard read
    from. Computed from AIAnalysis.components via ActivityMapping, not
    recomputed ad hoc per page load."""
    __tablename__ = "unit_activity_progress"
    id = Column(String(36), primary_key=True, default=gen_uuid)
    unit_id = Column(String(36), ForeignKey("units.id"), nullable=False)
    activity_id = Column(String(36), ForeignKey("activities.id"), nullable=False)
    progress_pct = Column(Float, nullable=True)   # null = "Cannot Assess"
    confidence_score = Column(Float, nullable=True)
    last_analysed = Column(DateTime, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    unit = relationship("Unit")
    activity = relationship("Activity", back_populates="unit_progress")


class ActivityExcelFile(Base):
    """The project's uploaded master Activity Excel — kept in sync in place
    (formulas/formatting/colors/validations/other sheets untouched) rather than
    regenerated. One per project."""
    __tablename__ = "activity_excel_files"
    id = Column(String(36), primary_key=True, default=gen_uuid)
    project_id = Column(String(36), ForeignKey("projects.id"), unique=True, nullable=False)
    file_url = Column(String(500))
    file_path = Column(String(500))   # local/GCS path used for in-place openpyxl edits
    original_filename = Column(String(255))
    sheet_name = Column(String(100))
    activity_col = Column(String(20))
    start_date_col = Column(String(20), nullable=True)
    end_date_col = Column(String(20), nullable=True)
    # {unit_id: <Excel column index>} — a Unit is the Excel's "Room" grain
    # (e.g. "A-101"); columns that didn't match a real Unit are omitted here
    # until manually linked via PUT /activity-excel/unit-map.
    unit_col_map = Column(JSON, nullable=True)
    version = Column(Integer, default=1)
    uploaded_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class AnalysisJob(Base):
    """One 'Start AI Analysis' run — snapshots every pending MediaUpload for the
    project at creation time and processes them asynchronously via job_worker.py."""
    __tablename__ = "analysis_jobs"
    id = Column(String(36), primary_key=True, default=gen_uuid)
    project_id = Column(String(36), ForeignKey("projects.id"), nullable=False)
    status = Column(Enum(AnalysisJobStatus), default=AnalysisJobStatus.pending)
    total_images = Column(Integer, default=0)
    processed_images = Column(Integer, default=0)
    failed_images = Column(Integer, default=0)
    requested_by = Column(String(36), ForeignKey("users.id"), nullable=True)
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)
