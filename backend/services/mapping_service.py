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
from datetime import date, datetime, time
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


def _latest_confident_by_activity(
    area_id: str, project_id: str, threshold: float, db: Session,
    lookup: Optional[Dict[str, str]] = None, cutoff: Optional[datetime] = None,
) -> Dict[str, dict]:
    """For one Area (Room model), the latest confident value per activity —
    walks its AIAnalysis history, maps each raw component through the
    project's mapping table, applies confidence_threshold.

    `cutoff` restricts the walk to analyses at or before a point in time, which
    is what makes an "as of <date>" view possible: the history lives in
    AIAnalysis (timestamped), even though UnitActivityProgress only persists
    the latest value. `lookup` swaps the side-effectful resolve_component (which
    logs UnmappedComponent and commits) for a read-only mapping dict, so GET
    paths can call this without writing."""
    q = db.query(AIAnalysis).filter(AIAnalysis.room_id == area_id)
    if cutoff is not None:
        q = q.filter(AIAnalysis.analysed_at <= cutoff)
    analyses = q.order_by(AIAnalysis.analysed_at.asc()).all()
    latest_by_activity: Dict[str, dict] = {}
    for analysis in analyses:
        _apply_analysis(analysis, latest_by_activity, project_id, threshold, db, lookup)
    return latest_by_activity


def _apply_analysis(
    analysis: AIAnalysis, state: Dict[str, dict], project_id: str,
    threshold: float, db: Session, lookup: Optional[Dict[str, str]] = None,
) -> None:
    """Fold one analysis into a running latest-confident-per-activity `state`.

    Split out so a chronological walk can be replayed incrementally (the
    progress *series* snapshots this state at each date boundary in a single
    pass) instead of re-walking the whole history once per date."""
    for component_key, value in (analysis.components or {}).items():
        if not isinstance(value, dict):
            continue  # legacy flat-number analyses predate the confidence schema — skip
        pct = value.get("pct")
        confidence = value.get("confidence")
        if pct is None or confidence is None or confidence < threshold:
            continue
        activity_id = (
            lookup.get(component_key) if lookup is not None
            else resolve_component(project_id, component_key, db)
        )
        if not activity_id:
            continue
        state[activity_id] = {
            "pct": pct, "confidence": confidence, "analysed_at": analysis.analysed_at,
        }


def _aggregate_unit(
    unit: Unit, project_id: str, threshold: float, db: Session,
    lookup: Optional[Dict[str, str]] = None, cutoff: Optional[datetime] = None,
) -> Dict[str, dict]:
    """One Unit's combined-average across its own Areas, per activity:
    activity_id -> {"pct", "confidence", "last_analysed"}. Shared by the
    persisted rollup and the read-only "as of <date>" view so the two can
    never drift apart."""
    pcts_by_activity: Dict[str, List[float]] = {}
    confidences_by_activity: Dict[str, List[float]] = {}
    latest_ts_by_activity: Dict[str, datetime] = {}

    for area in unit.rooms:
        area_values = _latest_confident_by_activity(
            area.id, project_id, threshold, db, lookup=lookup, cutoff=cutoff
        )
        for activity_id, data in area_values.items():
            pcts_by_activity.setdefault(activity_id, []).append(data["pct"])
            confidences_by_activity.setdefault(activity_id, []).append(data["confidence"])
            ts = data["analysed_at"]
            if activity_id not in latest_ts_by_activity or ts > latest_ts_by_activity[activity_id]:
                latest_ts_by_activity[activity_id] = ts

    return {
        activity_id: {
            "pct": sum(pcts) / len(pcts),
            "confidence": sum(confidences_by_activity[activity_id]) / len(confidences_by_activity[activity_id]),
            "last_analysed": latest_ts_by_activity[activity_id],
        }
        for activity_id, pcts in pcts_by_activity.items()
    }


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

    for activity_id, data in _aggregate_unit(unit, project.id, threshold, db).items():
        row = (
            db.query(UnitActivityProgress)
            .filter(UnitActivityProgress.unit_id == unit_id, UnitActivityProgress.activity_id == activity_id)
            .first()
        )
        if not row:
            row = UnitActivityProgress(unit_id=unit_id, activity_id=activity_id)
            db.add(row)
        # Only ever writes the AI columns. A manual override lives in
        # manual_pct/is_overridden, so re-running analysis refreshes what the
        # AI thinks without destroying a correction someone already made —
        # readers resolve the two via UnitActivityProgress.effective_pct.
        row.progress_pct = data["pct"]
        row.confidence_score = data["confidence"]
        row.last_analysed = data["last_analysed"]
        row.updated_at = datetime.utcnow()
    db.commit()


def _project_area_ids(project_id: str, db: Session) -> List[str]:
    """Every Area (Room) hanging off this project's Units — the grain the
    Executive dashboard's Unit x Activity matrix is built from."""
    area_ids: List[str] = []
    for f in db.query(Floor).filter(Floor.project_id == project_id).all():
        for u in f.units:
            area_ids.extend(r.id for r in u.rooms)
    return area_ids


def analysis_dates_for_project(project_id: str, db: Session) -> List[str]:
    """Distinct calendar dates (newest first, ISO) on which this project's
    Areas were analysed — the set of points in time the dashboard can be
    rewound to."""
    area_ids = _project_area_ids(project_id, db)
    if not area_ids:
        return []
    rows = (
        db.query(AIAnalysis.analysed_at)
        .filter(AIAnalysis.room_id.in_(area_ids), AIAnalysis.analysed_at.isnot(None))
        .all()
    )
    return sorted({r[0].date().isoformat() for r in rows}, reverse=True)


def unit_activity_matrix_as_of(
    project_id: str, unit_ids: List[str], as_of: date, db: Session
) -> List[dict]:
    """Point-in-time equivalent of the persisted UnitActivityProgress rows:
    what each (Unit, Activity) cell looked like at the end of `as_of`.

    Computed on the fly and never written back — UnitActivityProgress stays
    the "latest" store. Read-only throughout (mapping via _mapping_lookup, so
    no UnmappedComponent logging on this GET path)."""
    project = db.query(Project).get(project_id)
    if not project or not unit_ids:
        return []
    threshold = project.confidence_threshold if project.confidence_threshold is not None else 0.5
    lookup = _mapping_lookup(project_id, db)
    cutoff = datetime.combine(as_of, time.max)

    cells: List[dict] = []
    for unit in db.query(Unit).filter(Unit.id.in_(unit_ids)).all():
        aggregated = _aggregate_unit(unit, project_id, threshold, db, lookup=lookup, cutoff=cutoff)
        for activity_id, data in aggregated.items():
            cells.append({
                "activity_id": activity_id, "unit_id": unit.id,
                "pct": data["pct"], "confidence": data["confidence"],
                "last_analysed": data["last_analysed"],
            })
    return cells


def apply_manual_overrides(
    cells: List[dict], unit_ids: List[str], db: Session, as_of: date = None
) -> List[dict]:
    """Layer human corrections over AI-computed cells.

    Each cell keeps the AI number in `ai_pct` and exposes the corrected one
    as `pct`, so every existing consumer (KPI tiles, charts, the activity
    table) picks up the correction without knowing overrides exist.

    An override can also exist for a (Unit, Activity) the AI never scored —
    that is precisely the "AI said Cannot Assess but the work is done" case —
    so those are appended rather than only merged.

    `as_of` rewinds the corrections too: a dashboard rewound to last Tuesday
    must not show a correction someone made this morning, or the historical
    view stops being historical. Overrides with no timestamp are treated as
    always-applied, since they cannot be placed in time.
    """
    if not unit_ids:
        return cells
    rows = (
        db.query(UnitActivityProgress)
        .filter(
            UnitActivityProgress.unit_id.in_(unit_ids),
            UnitActivityProgress.is_overridden.is_(True),
        )
        .all()
    )
    if as_of is not None:
        rows = [
            r for r in rows
            if r.overridden_at is None or r.overridden_at.date() <= as_of
        ]
    if not rows:
        return cells

    by_key = {(r.activity_id, r.unit_id): r for r in rows}
    seen = set()
    merged: List[dict] = []
    for cell in cells:
        key = (cell["activity_id"], cell["unit_id"])
        row = by_key.get(key)
        if row is None:
            merged.append(cell)
            continue
        seen.add(key)
        merged.append({**cell, **_override_fields(row, ai_pct=cell["pct"])})

    # Corrections on cells the AI never produced a value for.
    for key, row in by_key.items():
        if key in seen:
            continue
        merged.append({
            "activity_id": row.activity_id, "unit_id": row.unit_id,
            "confidence": row.confidence_score, "last_analysed": row.last_analysed,
            **_override_fields(row, ai_pct=row.progress_pct),
        })
    return merged


def _override_fields(row: "UnitActivityProgress", ai_pct) -> dict:
    """The override half of a matrix cell. `pct` is deliberately the
    corrected value: callers should not have to know which of the two
    numbers is authoritative."""
    return {
        "pct": row.manual_pct,
        "ai_pct": ai_pct,
        "is_override": True,
        "override_note": row.manual_note,
        "overridden_at": row.overridden_at,
        "overridden_by": row.overridden_by,
    }


def _area_snapshots(
    area_id: str, project_id: str, threshold: float, lookup: Dict[str, str],
    dates: List[date], db: Session,
) -> Dict[date, Dict[str, dict]]:
    """This Area's latest-confident-per-activity state at the end of each date
    in `dates` (which must be ascending) — ONE pass over its history.

    Calling unit_activity_matrix_as_of once per date would re-walk the whole
    history for every point on the chart; this walks it once and snapshots as
    it crosses each date boundary."""
    analyses = (
        db.query(AIAnalysis)
        .filter(AIAnalysis.room_id == area_id)
        .order_by(AIAnalysis.analysed_at.asc())
        .all()
    )
    snapshots: Dict[date, Dict[str, dict]] = {}
    state: Dict[str, dict] = {}
    i = 0
    for d in dates:
        cutoff = datetime.combine(d, time.max)
        while i < len(analyses) and analyses[i].analysed_at <= cutoff:
            _apply_analysis(analyses[i], state, project_id, threshold, db, lookup)
            i += 1
        # Shallow copy: entries are replaced wholesale by _apply_analysis,
        # never mutated in place, so snapshots stay independent.
        snapshots[d] = dict(state)
    return snapshots


def progress_series(project_id: str, db: Session) -> List[dict]:
    """Real overall-completion history: one point per capture date, per Unit.

    Returns [{"date", "units": [{"unit_id", "pct", "n"}]}] where `pct` is that
    Unit's mean across its assessed activities and `n` is how many activity
    cells that mean covers. The caller re-weights by `n` (rather than
    averaging the averages) so a floor-filtered total matches the dashboard's
    own cell-level mean exactly.

    Read-only and non-persisting, like unit_activity_matrix_as_of."""
    project = db.query(Project).get(project_id)
    if not project:
        return []
    dates = [date.fromisoformat(d) for d in reversed(analysis_dates_for_project(project_id, db))]
    if not dates:
        return []
    threshold = project.confidence_threshold if project.confidence_threshold is not None else 0.5
    lookup = _mapping_lookup(project_id, db)

    units = [u for f in db.query(Floor).filter(Floor.project_id == project_id).all() for u in f.units]
    # unit_id -> date -> [per-activity pct], combined-averaged across the
    # Unit's Areas exactly as _aggregate_unit does for the latest view.
    per_unit: Dict[str, Dict[date, Dict[str, List[float]]]] = {}
    for unit in units:
        by_date: Dict[date, Dict[str, List[float]]] = {d: {} for d in dates}
        for area in unit.rooms:
            snapshots = _area_snapshots(area.id, project_id, threshold, lookup, dates, db)
            for d, state in snapshots.items():
                for activity_id, data in state.items():
                    by_date[d].setdefault(activity_id, []).append(data["pct"])
        per_unit[unit.id] = by_date

    series: List[dict] = []
    for d in dates:
        unit_points = []
        for unit in units:
            per_activity = per_unit[unit.id][d]
            values = [sum(pcts) / len(pcts) for pcts in per_activity.values()]
            if not values:
                continue  # nothing assessed for this Unit yet — omit, never zero-fill
            unit_points.append({
                "unit_id": unit.id,
                "pct": sum(values) / len(values),
                "n": len(values),
            })
        series.append({"date": d.isoformat(), "units": unit_points})
    return series


def _project_for_unit(unit: Unit, db: Session) -> Optional[Project]:
    if unit.floor:
        return db.query(Project).get(unit.floor.project_id)
    return None
