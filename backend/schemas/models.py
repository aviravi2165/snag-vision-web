from pydantic import BaseModel, EmailStr
from typing import Optional, Dict, List, Any
from datetime import datetime
from models.database import UserRole, UploadStatus, IssueStatus, IssuePriority


# --- Auth ---
class UserCreate(BaseModel):
    name: str
    email: EmailStr
    password: str
    role: UserRole = UserRole.site_supervisor

class UserOut(BaseModel):
    id: str
    name: str
    email: str
    role: UserRole
    class Config:
        from_attributes = True

class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut

class LoginIn(BaseModel):
    email: EmailStr
    password: str


# --- Project ---
class ProjectCreate(BaseModel):
    name: str
    location: Optional[str] = None
    total_floors: int = 1
    planned_completion: Optional[datetime] = None
    estimated_completion_date: Optional[datetime] = None
    folder: Optional[str] = None
    city: Optional[str] = None

class ProjectOut(BaseModel):
    id: str
    name: str
    location: Optional[str]
    total_floors: int
    planned_completion: Optional[datetime]
    created_at: datetime
    progress_pct: Optional[float] = None
    folder: Optional[str] = None
    city: Optional[str] = None
    class Config:
        from_attributes = True


class ActivityItem(BaseModel):
    id: Optional[str] = None
    name: str
    start_date: Optional[str] = None   # ISO date string (YYYY-MM-DD)
    target_date: Optional[str] = None  # ISO date string — alias for the activity's end/target date


class ActivityPlanIn(BaseModel):
    activities: List[ActivityItem]


class UnitMapIn(BaseModel):
    unit_id: str
    col_index: int


class ActivityMappingIn(BaseModel):
    component_key: str
    activity_id: str
    confidence: float = 1.0


# --- Floor / Unit / Room ---
class FloorCreate(BaseModel):
    floor_number: int
    label: Optional[str] = None

class FloorOut(BaseModel):
    id: str
    floor_number: int
    label: Optional[str]
    progress_pct: float
    plan_image_url: Optional[str] = None
    class Config:
        from_attributes = True

class UnitCreate(BaseModel):
    unit_number: str

class RoomCreate(BaseModel):
    name: str

class RoomOut(BaseModel):
    id: str
    name: str
    progress_pct: float
    last_analysed: Optional[datetime]
    class Config:
        from_attributes = True


# --- Spot (floor-plan capture pin) ---
class SpotCreate(BaseModel):
    name: str
    coordinate_x: float  # normalized 0..1, relative to the floor plan image
    coordinate_y: float
    sort_order: int = 1

class SpotOut(BaseModel):
    id: str
    room_id: str
    name: str
    coordinate_x: float
    coordinate_y: float
    sort_order: int
    class Config:
        from_attributes = True


# Mobile's offline-first spot sync — camelCase to match this router's own
# convention (see upload_photo's Form(...) params in routers/mobile.py).
class MobileSpotCreate(BaseModel):
    clientSpotId: str
    roomId: str
    name: str
    coordinateX: float
    coordinateY: float
    sortOrder: int = 1


# --- Upload ---
class UploadOut(BaseModel):
    id: str
    room_id: str
    spot_id: Optional[str] = None
    gcs_url: str
    media_type: str
    file_name: str
    notes: Optional[str]
    status: UploadStatus
    uploaded_at: datetime
    # The walkthrough (CaptureSession) this capture belongs to — set for every
    # capture written after the unified media pipeline; None for pre-walkthrough
    # era rows. Additive; old clients ignore it.
    walkthrough_id: Optional[str] = None
    class Config:
        from_attributes = True


# --- AI Analysis ---
class AnalysisOut(BaseModel):
    id: str
    room_id: str
    upload_id: str
    components: Dict[str, float]
    overall_pct: float
    ai_notes: Optional[str]
    prev_overall_pct: Optional[float]
    delta_pct: Optional[float]
    change_flag: Optional[str]
    analysed_at: datetime
    class Config:
        from_attributes = True


# --- Dashboard ---
class RoomProgress(BaseModel):
    room_id: str
    room_name: str
    pct: float
    components: Optional[Dict[str, float]]
    change_flag: Optional[str]

class UnitProgress(BaseModel):
    unit_id: str
    unit_number: str
    pct: float
    rooms: List[RoomProgress]

class FloorProgress(BaseModel):
    floor_id: str
    floor_number: int
    label: Optional[str]
    pct: float
    units: List[UnitProgress]

class ProjectDashboard(BaseModel):
    project_id: str
    project_name: str
    overall_pct: float
    floors: List[FloorProgress]
    active_delays: int
    est_completion: Optional[str]
    weekly_trend: List[Dict]


# --- Site (Layout Setup / Site Capture / Panorama persistence) ---
class SiteRoomIn(BaseModel):
    id: str
    name: str

class SiteFloorIn(BaseModel):
    number: int
    rooms: List[SiteRoomIn] = []

class SiteProjectCreate(BaseModel):
    name: str
    location: Optional[str] = None
    total_floors: int = 1
    floors: List[SiteFloorIn] = []

class HotspotCreate(BaseModel):
    floor_number: int
    x_pct: float
    y_pct: float
    room_id: Optional[str] = None
    room_name: Optional[str] = None


# --- Site Photo Viewer markers + Issue Management ---------------------------
# See routers/issues.py. MarkerIn is intentionally issue-agnostic so other
# marker types (AI defects, QA, safety) can post the same shape later.

class MarkerIn(BaseModel):
    space: str = "equirect"          # "equirect" (360 sphere) | "image" (flat photo)
    u: float
    v: float
    location_id: str                 # the Spot / sub-Room the viewer resolved to
    location_kind: Optional[str] = None      # "subroom" | "spot"
    parent_location_id: Optional[str] = None # Unit, or flat mobile Room
    floor_id: Optional[str] = None
    origin_upload_id: Optional[str] = None
    marker_type: str = "issue"


class MarkerOut(BaseModel):
    id: str
    project_id: str
    marker_type: str
    space: str
    u: float
    v: float
    floor_id: Optional[str] = None
    parent_location_id: Optional[str] = None
    location_id: str
    location_kind: Optional[str] = None
    origin_upload_id: Optional[str] = None
    origin_captured_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    # Human-readable location, resolved server-side so the project-wide issue
    # list can show and filter by where each issue lives without the client
    # having to walk the Floor/Unit/Room hierarchy itself.
    floor_number: Optional[int] = None
    parent_label: Optional[str] = None   # Room ID (Unit number, or flat Room name)
    location_label: Optional[str] = None # Spot (sub-Room name, or Spot name)


class IssueCreate(BaseModel):
    project_id: str
    title: str
    description: Optional[str] = None
    priority: IssuePriority = IssuePriority.medium
    due_date: Optional[datetime] = None
    assignee_ids: List[str] = []
    marker: Optional[MarkerIn] = None   # created atomically with the issue


class IssueUpdate(BaseModel):
    """Every field optional — this is a PATCH; only what's sent is changed."""
    title: Optional[str] = None
    description: Optional[str] = None
    priority: Optional[IssuePriority] = None
    status: Optional[IssueStatus] = None
    due_date: Optional[datetime] = None
    assignee_ids: Optional[List[str]] = None


class IssueCommentIn(BaseModel):
    body: str


class IssueCommentOut(BaseModel):
    id: str
    issue_id: str
    body: str
    kind: str
    created_at: datetime
    author: Optional[Dict[str, Any]] = None


class IssueOut(BaseModel):
    id: str
    project_id: str
    title: str
    description: Optional[str] = None
    priority: IssuePriority
    status: IssueStatus
    due_date: Optional[datetime] = None
    assignee_ids: List[str] = []
    assignees: List[Dict[str, Any]] = []   # resolved {id,name,email} for display
    created_by: Optional[str] = None
    created_by_user: Optional[Dict[str, Any]] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    resolved_at: Optional[datetime] = None
    marker: Optional[MarkerOut] = None
    comment_count: int = 0


# --- Walkthroughs (CaptureSession, exposed to the UI everywhere as a
# "Walkthrough") ---
# The row itself is a generic session (session_type default "walkthrough" — the
# same extensibility seam as Marker.marker_type); only the API/UI language is
# walkthrough-specific. See models/database.py::CaptureSession.

class WalkthroughOut(BaseModel):
    id: str
    project_id: str
    session_type: str
    number: int
    status: str                       # WalkthroughStatus value string
    started_at: Optional[datetime] = None
    ready_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    ai_started_at: Optional[datetime] = None
    ai_completed_at: Optional[datetime] = None
    created_by: Optional[str] = None
    created_at: Optional[datetime] = None
    # Derived per-walkthrough media counts (filled in by the routers' serializers)
    capture_count: int = 0
    pending_count: int = 0
    done_count: int = 0
    failed_count: int = 0


class RequestCompleteOut(BaseModel):
    """POST /walkthroughs/{id}/request-complete — always transitions to
    ready_to_complete (zero captures is a hard 400); `warnings` lists the
    expected rooms (hotspots pinned in Setup) with no capture yet, so the
    UI can ask "capture these, or complete anyway?" before confirming."""
    walkthrough: WalkthroughOut
    warnings: List[Dict[str, Any]] = []   # [{room_id, room_name, floor_number}]


class MediaGroupOut(BaseModel):
    """One section of the Media Manager — a walkthrough's uploads plus its
    summary row (Total / Pending AI / Done / Failed)."""
    walkthrough: Optional[WalkthroughOut] = None   # None = pre-walkthrough-era legacy group
    label: str
    summary: Dict[str, int]
    media: List[Dict[str, Any]]


class ProjectMediaOut(BaseModel):
    """GET /uploads/project/{project_id} — grouped by walkthrough, newest first."""
    project_id: str
    groups: List[MediaGroupOut]

