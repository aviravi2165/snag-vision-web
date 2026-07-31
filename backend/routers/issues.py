"""
Site Photo Viewer markers + Issue Management.

Two routers live here on purpose:

  * `markers_router` (/markers) — the generic marker layer. A marker is just a
    pin at (u, v) anchored to a LOCATION, with a `marker_type` discriminator.
    Issues are only the first consumer; AI-detected defects, progress
    checkpoints, QA inspections and safety observations can post/read the exact
    same shape without going anywhere near /issues. Keeping it under its own
    prefix (rather than /issues/markers) is what makes that honest.

  * `router` (/issues) — issue CRUD, status workflow and the comment thread.

Markers are anchored to `location_id` (the Spot/sub-Room the viewer's 4th
filter resolves to), NOT to a single upload, so a marker raised on one capture
still shows when a later capture of the same spot is opened — that's what lets
a supervisor see whether the defect was actually fixed. The capture it was
raised against is kept on `origin_upload_id` / `origin_captured_at`.
"""
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from models import get_db
from models.database import (
    Issue, IssueComment, IssueStatus, Marker, MediaUpload, Project, User,
)
from routers.auth import get_current_user
from schemas.models import (
    IssueCommentIn, IssueCommentOut, IssueCreate, IssueOut, IssueUpdate, MarkerOut,
)

router = APIRouter(prefix="/issues", tags=["issues"], dependencies=[Depends(get_current_user)])
markers_router = APIRouter(prefix="/markers", tags=["markers"], dependencies=[Depends(get_current_user)])


# ── Serializers (dict-returning `_xxx_out` helpers, matching routers/site.py) ──

def _user_out(u: Optional[User]) -> Optional[dict]:
    if not u:
        return None
    return {"id": u.id, "name": u.name, "email": u.email,
            "role": u.role.value if u.role else None}


def _marker_out(m: Optional[Marker]) -> Optional[dict]:
    if not m:
        return None
    return {
        "id": m.id, "project_id": m.project_id, "marker_type": m.marker_type,
        "space": m.space, "u": m.u, "v": m.v,
        "floor_id": m.floor_id, "parent_location_id": m.parent_location_id,
        "location_id": m.location_id, "location_kind": m.location_kind,
        "origin_upload_id": m.origin_upload_id,
        "origin_captured_at": m.origin_captured_at,
        "created_at": m.created_at,
    }


def _issue_out(i: Issue, db: Session) -> dict:
    assignee_ids = i.assignee_ids or []
    assignees = (
        db.query(User).filter(User.id.in_(assignee_ids)).all() if assignee_ids else []
    )
    return {
        "id": i.id, "project_id": i.project_id,
        "title": i.title, "description": i.description,
        "priority": i.priority, "status": i.status,
        "due_date": i.due_date,
        "assignee_ids": assignee_ids,
        "assignees": [_user_out(u) for u in assignees],
        "created_by": i.created_by,
        "created_by_user": _user_out(db.query(User).get(i.created_by)) if i.created_by else None,
        "created_at": i.created_at, "updated_at": i.updated_at,
        "resolved_at": i.resolved_at,
        "marker": _marker_out(i.marker),
        "comment_count": len(i.comments),
    }


def _comment_out(c: IssueComment, db: Session) -> dict:
    return {
        "id": c.id, "issue_id": c.issue_id, "body": c.body, "kind": c.kind,
        "created_at": c.created_at,
        "author": _user_out(db.query(User).get(c.author_id)) if c.author_id else None,
    }


# ── Markers (generic layer) ──────────────────────────────────────────────────

@markers_router.get("", response_model=List[MarkerOut])
def list_markers(
    location_id: str = Query(..., description="Spot / sub-Room the viewer is showing"),
    marker_type: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """Every marker pinned at this location, across all capture dates."""
    q = db.query(Marker).filter(Marker.location_id == location_id)
    if marker_type:
        q = q.filter(Marker.marker_type == marker_type)
    return [_marker_out(m) for m in q.order_by(Marker.created_at).all()]


# ── Issues ───────────────────────────────────────────────────────────────────

@router.get("", response_model=List[IssueOut])
def list_issues(
    location_id: Optional[str] = None,
    project_id: Optional[str] = None,
    status: Optional[IssueStatus] = None,
    q: Optional[str] = Query(None, description="Free-text search over title/description"),
    db: Session = Depends(get_db),
):
    if not location_id and not project_id:
        raise HTTPException(400, "Pass either location_id or project_id")

    query = db.query(Issue)
    if location_id:
        # Location scoping goes through the marker — an issue with no marker
        # isn't tied to a location, so it correctly doesn't appear here.
        query = query.join(Marker, Issue.marker_id == Marker.id).filter(
            Marker.location_id == location_id
        )
    if project_id:
        query = query.filter(Issue.project_id == project_id)
    if status:
        query = query.filter(Issue.status == status)
    if q:
        like = f"%{q}%"
        query = query.filter(Issue.title.ilike(like) | Issue.description.ilike(like))
    return [_issue_out(i, db) for i in query.order_by(Issue.created_at.desc()).all()]


@router.post("", response_model=IssueOut, status_code=201)
def create_issue(data: IssueCreate, db: Session = Depends(get_db),
                 user: User = Depends(get_current_user)):
    """Creates the Issue and (when `marker` is supplied) its Marker in one
    transaction, so a half-placed marker can never be left behind."""
    if not db.query(Project).get(data.project_id):
        raise HTTPException(404, "Project not found")

    marker = None
    if data.marker:
        m = data.marker
        # Stamp the marker with the capture it was raised against, so the UI can
        # show "raised on <date>" when viewed from a different capture date.
        captured_at = None
        if m.origin_upload_id:
            up = db.query(MediaUpload).get(m.origin_upload_id)
            captured_at = up.uploaded_at if up else None
        marker = Marker(
            project_id=data.project_id, marker_type=m.marker_type,
            space=m.space, u=m.u, v=m.v,
            floor_id=m.floor_id, parent_location_id=m.parent_location_id,
            location_id=m.location_id, location_kind=m.location_kind,
            origin_upload_id=m.origin_upload_id, origin_captured_at=captured_at,
            created_by=user.id,
        )
        db.add(marker)
        db.flush()

    issue = Issue(
        project_id=data.project_id,
        marker_id=marker.id if marker else None,
        title=data.title, description=data.description,
        priority=data.priority, status=IssueStatus.open,
        due_date=data.due_date,
        assignee_ids=data.assignee_ids or [],
        created_by=user.id,
    )
    db.add(issue)
    db.commit()
    db.refresh(issue)
    return _issue_out(issue, db)


@router.get("/{issue_id}", response_model=IssueOut)
def get_issue(issue_id: str, db: Session = Depends(get_db)):
    issue = db.query(Issue).get(issue_id)
    if not issue:
        raise HTTPException(404, "Issue not found")
    return _issue_out(issue, db)


@router.patch("/{issue_id}", response_model=IssueOut)
def update_issue(issue_id: str, data: IssueUpdate, db: Session = Depends(get_db),
                 user: User = Depends(get_current_user)):
    issue = db.query(Issue).get(issue_id)
    if not issue:
        raise HTTPException(404, "Issue not found")

    previous_status = issue.status
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(issue, field, value)

    if data.status is not None and data.status != previous_status:
        # Stamp when it was resolved; keep that stamp through a later "closed"
        # (a closed issue was still resolved at some point), and only clear it
        # if the issue is genuinely reopened.
        if data.status == IssueStatus.resolved:
            issue.resolved_at = datetime.utcnow()
        elif data.status in (IssueStatus.open, IssueStatus.in_progress):
            issue.resolved_at = None
        # Log the transition into the same thread so it reads as an audit trail.
        db.add(IssueComment(
            issue_id=issue.id, author_id=user.id, kind="status_change",
            body=f"Status changed from {previous_status.value} to {data.status.value}",
        ))

    db.commit()
    db.refresh(issue)
    return _issue_out(issue, db)


@router.delete("/{issue_id}", status_code=204)
def delete_issue(issue_id: str, db: Session = Depends(get_db)):
    issue = db.query(Issue).get(issue_id)
    if not issue:
        raise HTTPException(404, "Issue not found")
    marker = issue.marker
    db.delete(issue)
    # A marker exists to carry its issue — once that's gone the orphan pin would
    # just be a dot on the panorama with nothing behind it.
    if marker and len(marker.issues) <= 1:
        db.delete(marker)
    db.commit()


# ── Comments ─────────────────────────────────────────────────────────────────

@router.get("/{issue_id}/comments", response_model=List[IssueCommentOut])
def list_comments(issue_id: str, db: Session = Depends(get_db)):
    issue = db.query(Issue).get(issue_id)
    if not issue:
        raise HTTPException(404, "Issue not found")
    return [_comment_out(c, db) for c in issue.comments]


@router.post("/{issue_id}/comments", response_model=IssueCommentOut, status_code=201)
def add_comment(issue_id: str, data: IssueCommentIn, db: Session = Depends(get_db),
                user: User = Depends(get_current_user)):
    if not db.query(Issue).get(issue_id):
        raise HTTPException(404, "Issue not found")
    c = IssueComment(issue_id=issue_id, author_id=user.id, body=data.body, kind="comment")
    db.add(c)
    db.commit()
    db.refresh(c)
    return _comment_out(c, db)
