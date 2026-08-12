"""
Component -> Activity mapping.

Gemini's vision analysis (services/gemini_service.py::build_prompt, open-
vocabulary mode) detects whatever construction components it recognizes in a
photo — it has no idea what a given project calls its activities. This module
is the translation layer: a per-project, AI-generated (and manually editable)
table of component_key -> Activity, built once from the project's own Activity
Excel, then used at aggregation time (never at prompt-generation time) to turn
raw AIAnalysis.components into UnitActivityProgress rows.

Because the mapping lives here — not in the prompt — fixing a bad mapping
never requires re-running AI on any image; only recompute_unit_activity_progress
needs to re-run.

Grain note: the Activity Excel's "Room" columns are Units (e.g. "A-101") —
Floor View already handles the finer Area-level breakdown (Living/Bathroom,
the `Room` model) via its own room->unit->floor rollup. So progress here is
computed per Unit, combined-averaging across that Unit's Areas — never
per-Area — to avoid duplicating (and potentially conflicting with) Floor View.
"""
import json
from datetime import datetime
from typing import Dict, List, Optional

from sqlalchemy.orm import Session

from models.database import (
    Activity, ActivityMapping, UnmappedComponent, UnitActivityProgress,
    Unit, Floor, AIAnalysis, Project,
)
from services.gemini_service import _get_client, slugify_activity
from google.genai import types


def _mapping_prompt(activity_names: List[str]) -> str:
    bullet_lines = "\n".join(f"- {n}" for n in activity_names)
    return f"""
You are helping map AI-vision-detected construction/interior components to a
project's own activity list. You will NOT see any photos — just reason from
the activity names themselves.

Project activities:
{bullet_lines}

For each activity, list every short, lowercase, underscore-separated component
term a computer-vision model analysing a site photo would plausibly use when
it detects visual evidence relevant to that activity (e.g. an activity named
"Commercial Tiles" might be detected via components like "tile", "flooring",
"marble"; "MEP - Electrical" might be detected via "electrical", "wiring",
"conduit", "switchboard"). Propose 2-6 component terms per activity. Assign a
confidence 0.0-1.0 for how reliably that component term implies this specific
activity (not some other activity).

Respond ONLY with a valid JSON object matching this schema:
{{
  "<exact activity name as given above>": [
    {{"component": "<component_term>", "confidence": <0.0-1.0>}},
    ...
  ],
  ...
}}
"""


async def generate_ai_mapping(project_id: str, activities: List[Activity], db: Session) -> int:
    """One text-only Gemini call per project — proposes a component->activity
    mapping from the activity names alone. Stores rows with source="ai".
    Returns the number of mapping rows created."""
    if not activities:
        return 0

    prompt = _mapping_prompt([a.name for a in activities])
    try:
        response = await _get_client().aio.models.generate_content(
            model="gemini-2.5-flash",
            contents=[prompt],
            config=types.GenerateContentConfig(response_mime_type="application/json"),
        )
        data = json.loads(response.text)
    except Exception as e:
        print(f"generate_ai_mapping error: {e}")
        return 0

    name_to_activity = {a.name: a for a in activities}
    # Clear any prior AI-generated mapping for this project (a re-upload of the
    # Excel regenerates the mapping fresh) — manual overrides are untouched.
    db.query(ActivityMapping).filter(
        ActivityMapping.project_id == project_id, ActivityMapping.source == "ai"
    ).delete()

    created = 0
    for activity_name, components in (data or {}).items():
        activity = name_to_activity.get(activity_name)
        if not activity or not isinstance(components, list):
            continue
        for entry in components:
            component_key = slugify_activity(str(entry.get("component", "")))
            if not component_key or component_key == "activity":
                continue
            confidence = float(entry.get("confidence", 0.5))
            db.add(ActivityMapping(
                project_id=project_id, component_key=component_key,
                activity_id=activity.id, confidence=confidence, source="ai",
            ))
            created += 1
    db.commit()
    return created


def _mapping_lookup(project_id: str, db: Session) -> Dict[str, str]:
    """component_key -> activity_id for a project, best-confidence row wins.
    Read-only — no UnmappedComponent side effects (GET paths use this)."""
    rows = db.query(ActivityMapping).filter(ActivityMapping.project_id == project_id).all()
    lookup: Dict[str, str] = {}
    for m in sorted(rows, key=lambda r: r.confidence or 0.0, reverse=True):
        if m.component_key not in lookup:
            lookup[m.component_key] = m.activity_id
    return lookup


def mapped_breakdown(
    components: dict,
    project_id: str,
    db: Session,
    lookup: Optional[Dict[str, str]] = None,
    threshold: Optional[float] = None,
) -> List[dict]:
    """Group one analysis's raw components through the project's mapping table.

    Returns [{"activity_id", "pct", "confidence"}] — per-activity averages,
    applying the project's confidence threshold. Purely read-only: unlike
    resolve_component it never logs unmapped components, so it is safe on GET
    endpoints (AI Analysis / Floor View). Callers that already have the
    lookup/threshold handy pass them in to avoid re-querying per analysis."""
    if not components:
        return []
    if lookup is None:
        lookup = _mapping_lookup(project_id, db)
    if threshold is None:
        project = db.query(Project).get(project_id)
        threshold = project.confidence_threshold if project and project.confidence_threshold is not None else 0.5

    pcts_by_activity: Dict[str, List[float]] = {}
    conf_by_activity: Dict[str, List[float]] = {}
    for key, value in components.items():
        activity_id = lookup.get(key)
        if not activity_id:
            continue
        if isinstance(value, dict):
            pct = value.get("pct")
            confidence = value.get("confidence")
        else:
            pct, confidence = value, 1.0  # legacy flat-number analyses
        if pct is None or confidence is None or confidence < threshold:
            continue
        pcts_by_activity.setdefault(activity_id, []).append(pct)
        conf_by_activity.setdefault(activity_id, []).append(confidence)

    return [
        {
            "activity_id": aid,
            "pct": sum(pcts) / len(pcts),
            "confidence": sum(conf_by_activity[aid]) / len(conf_by_activity[aid]),
        }
        for aid, pcts in pcts_by_activity.items()
    ]


async def classify_observed_components(project_id: str, db: Session) -> int:
    """One text-only Gemini call per project: assign every *observed* component
    key (collected from this project's analyses) to one of its activities, or
    drop it. Writes ActivityMapping rows (source="ai", replacing prior ai rows)
    so the existing aggregation machinery can roll raw components up into the
    project's activity plan. Returns the number of mapping rows created."""
    room_ids: List[str] = []
    for f in db.query(Floor).filter(Floor.project_id == project_id).all():
        for u in f.units:
            room_ids.extend(r.id for r in u.rooms)
        room_ids.extend(r.id for r in f.rooms)  # flat (mobile) rooms
    if not room_ids:
        return 0

    keys: set = set()
    for a in db.query(AIAnalysis).filter(AIAnalysis.room_id.in_(room_ids)).all():
        if a.components:
            keys.update(a.components.keys())
    if not keys:
        return 0

    activities = db.query(Activity).filter(Activity.project_id == project_id).order_by(Activity.sort_order).all()
    if not activities:
        return 0

    activity_names = [a.name for a in activities]
    bullets = "\n".join(f"- {n}" for n in activity_names)
    labels = json.dumps(sorted(keys))
    prompt = f"""
You are mapping computer-vision component labels detected in construction/
interior site photos to a project's standard activity categories. For each
label pick the SINGLE activity it most strongly indicates — visual evidence
relevant to that activity. If a label fits no activity (e.g. a generic or
ambiguous term), omit it entirely.

Project activities:
{bullets}

Component labels:
{labels}

Respond ONLY with a JSON object. Each key is a component label; each value
is an object: {{"activity": "<exact activity name from the list>",
"confidence": <0.0-1.0>}}. Omit labels that fit no activity.
"""
    try:
        response = await _get_client().aio.models.generate_content(
            model="gemini-2.5-flash",
            contents=[prompt],
            config=types.GenerateContentConfig(response_mime_type="application/json"),
        )
        data = json.loads(response.text)
    except Exception as e:
        print(f"classify_observed_components error: {e}")
        return 0

    name_to_activity = {a.name: a.id for a in activities}
    db.query(ActivityMapping).filter(
        ActivityMapping.project_id == project_id, ActivityMapping.source == "ai"
    ).delete()

    created = 0
    for key, entry in (data or {}).items():
        if isinstance(entry, dict):
            activity_name = entry.get("activity")
            confidence = entry.get("confidence")
        elif isinstance(entry, str):
            activity_name, confidence = entry, 0.9
        else:
            continue
        if not activity_name:
            continue
        activity_id = name_to_activity.get(activity_name)
        if not activity_id:
            continue
        db.add(ActivityMapping(
            project_id=project_id, component_key=key, activity_id=activity_id,
            confidence=float(confidence or 0.9), source="ai",
        ))
        created += 1
    db.commit()
    return created


def resolve_component(project_id: str, component_key: str, db: Session) -> Optional[str]:
    """Look up the activity_id a raw component key maps to for this project.
    On a miss, logs it to UnmappedComponent (never fabricates a mapping) and
    returns None — the caller must skip that component for this project."""
    mapping = (
        db.query(ActivityMapping)
        .filter(ActivityMapping.project_id == project_id, ActivityMapping.component_key == component_key)
        .order_by(ActivityMapping.confidence.desc())
        .first()
    )
    if mapping:
        return mapping.activity_id

    unmapped = (
        db.query(UnmappedComponent)
        .filter(UnmappedComponent.project_id == project_id, UnmappedComponent.component_key == component_key)
        .first()
    )
    now = datetime.utcnow()
    if unmapped:
        unmapped.sample_count += 1
        unmapped.last_seen = now
    else:
        db.add(UnmappedComponent(project_id=project_id, component_key=component_key,
                                  sample_count=1, first_seen=now, last_seen=now))
    db.commit()
    return None


def _latest_confident_by_activity(area_id: str, project_id: str, threshold: float, db: Session) -> Dict[str, dict]:
    """For one Area (Room model), the latest confident value per activity —
    walks its AIAnalysis history, maps each raw component through the
    project's mapping table, applies confidence_threshold."""
    analyses = (
        db.query(AIAnalysis)
        .filter(AIAnalysis.room_id == area_id)
        .order_by(AIAnalysis.analysed_at.asc())
        .all()
    )
    latest_by_activity: Dict[str, dict] = {}
    for analysis in analyses:
        components = analysis.components or {}
        for component_key, value in components.items():
            if not isinstance(value, dict):
                continue  # legacy flat-number analyses predate the confidence schema — skip
            pct = value.get("pct")
            confidence = value.get("confidence")
            if pct is None or confidence is None or confidence < threshold:
                continue
            activity_id = resolve_component(project_id, component_key, db)
            if not activity_id:
                continue
            latest_by_activity[activity_id] = {
                "pct": pct, "confidence": confidence, "analysed_at": analysis.analysed_at,
            }
    return latest_by_activity


def recompute_unit_activity_progress(unit_id: str, db: Session) -> None:
    """A Unit (e.g. "A-101" — the Activity Excel's actual "Room" grain)
    combined-averages its own Areas' (Living/Bathroom, the `Room` model)
    latest confident per-activity values. Upserts UnitActivityProgress.
    Area-level detail keeps living on Floor View — this never touches
    Room.progress_pct or the room->unit->floor rollup."""
    unit = db.query(Unit).get(unit_id)
    if not unit:
        return
    project = _project_for_unit(unit, db)
    if not project:
        return
    threshold = project.confidence_threshold if project.confidence_threshold is not None else 0.5

    pcts_by_activity: Dict[str, List[float]] = {}
    confidences_by_activity: Dict[str, List[float]] = {}
    latest_ts_by_activity: Dict[str, datetime] = {}

    for area in unit.rooms:
        for activity_id, data in _latest_confident_by_activity(area.id, project.id, threshold, db).items():
            pcts_by_activity.setdefault(activity_id, []).append(data["pct"])
            confidences_by_activity.setdefault(activity_id, []).append(data["confidence"])
            ts = data["analysed_at"]
            if activity_id not in latest_ts_by_activity or ts > latest_ts_by_activity[activity_id]:
                latest_ts_by_activity[activity_id] = ts

    for activity_id, pcts in pcts_by_activity.items():
        confidences = confidences_by_activity[activity_id]
        row = (
            db.query(UnitActivityProgress)
            .filter(UnitActivityProgress.unit_id == unit_id, UnitActivityProgress.activity_id == activity_id)
            .first()
        )
        if not row:
            row = UnitActivityProgress(unit_id=unit_id, activity_id=activity_id)
            db.add(row)
        row.progress_pct = sum(pcts) / len(pcts)
        row.confidence_score = sum(confidences) / len(confidences)
        row.last_analysed = latest_ts_by_activity[activity_id]
        row.updated_at = datetime.utcnow()
    db.commit()


def _project_for_unit(unit: Unit, db: Session) -> Optional[Project]:
    if unit.floor:
        return db.query(Project).get(unit.floor.project_id)
    return None
