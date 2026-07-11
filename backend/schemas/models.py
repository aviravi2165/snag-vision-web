from pydantic import BaseModel, EmailStr
from typing import Optional, Dict, List
from datetime import datetime
from models.database import UserRole, UploadStatus


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

class ProjectOut(BaseModel):
    id: str
    name: str
    location: Optional[str]
    total_floors: int
    planned_completion: Optional[datetime]
    created_at: datetime
    progress_pct: Optional[float] = None
    class Config:
        from_attributes = True


# --- Floor / Unit / Room ---
class FloorCreate(BaseModel):
    floor_number: int
    label: Optional[str] = None

class FloorOut(BaseModel):
    id: str
    floor_number: int
    label: Optional[str]
    progress_pct: float
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


# --- Upload ---
class UploadOut(BaseModel):
    id: str
    room_id: str
    gcs_url: str
    media_type: str
    file_name: str
    notes: Optional[str]
    status: UploadStatus
    uploaded_at: datetime
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

