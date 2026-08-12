"""
Standard activity catalog.

The business tracks progress against a fixed, standard 12-category plan
("Structural and Civil Works", "Flooring Tiling", ...). These are the
canonical names shown in Floor View and AI Analysis, computed from raw
Gemini component keys through a GLOBAL classifier
(StandardComponentMapping — one row per component key, shared by every
project), NOT through a project's own Activity plan.

The per-project Activity plan is a separate concern: it comes from the
project's Activity Excel (the BoQ items) and drives the Executive
dashboard via ActivityMapping / UnitActivityProgress
(services/mapping_service.py). A photo analysis therefore updates BOTH
views: Floor View / AI Analysis through the standard classifier here, and
the Executive dashboard through the per-project mapping machinery.
"""

import json
from datetime import datetime
from typing import Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from models.database import (
    ActivityMapping, StandardComponentMapping, AIAnalysis,
)
from services.gemini_service import _get_client
from google.genai import types

STANDARD_ACTIVITIES: List[str] = [
    "Structural and Civil Works",
    "Flooring Tiling",
    "Blockwork and Ceilings",
    "Painting Polishing and Finishes",
    "Architectural Details",
    "Mechanical",
    "Electrical",
    "Plumbing",
    "Interior Design and Space Planning",
    "Lighting Fixtures and Fittings",
    "Doors Windows and Fixed Openings",
    "Furniture and Fixtures",
]


def standard_lookup(db: Session) -> Dict[str, Tuple[str, float]]:
    """component_key -> (category, confidence) — the global standard
    classifier. Read-only, no side effects (safe on GET endpoints)."""
    rows = db.query(StandardComponentMapping).all()
    return {r.component_key: (r.category, r.confidence or 0.0) for r in rows}


def standard_breakdown(
    components: dict,
    db: Session,
    lookup: Optional[Dict[str, Tuple[str, float]]] = None,
    threshold: float = 0.5,
) -> List[dict]:
    """Group one analysis's raw Gemini components into the standard 12
    categories via the global classifier.

    Returns [{"name", "pct", "confidence"}] — per-category averages of the
    mapped components, applying both the mapping's own confidence and the
    per-component confidence. Purely read-only and project-independent: this
    is what AI Analysis / Floor View render, regardless of the project's own
    Activity plan. Callers that already have the lookup pass it in to avoid
    re-querying per analysis.
    """
    if not components:
        return []
    if lookup is None:
        lookup = standard_lookup(db)

    pcts_by_category: Dict[str, List[float]] = {}
    conf_by_category: Dict[str, List[float]] = {}
    for key, value in components.items():
        entry = lookup.get(key)
        if not entry:
            continue
        category, mapping_confidence = entry
        if mapping_confidence < threshold:
            continue
        if isinstance(value, dict):
            pct = value.get("pct")
            confidence = value.get("confidence")
        else:
            pct, confidence = value, 1.0  # legacy flat-number analyses
        if pct is None or confidence is None or confidence < threshold:
            continue
        pcts_by_category.setdefault(category, []).append(pct)
        conf_by_category.setdefault(category, []).append(confidence)

    return [
        {
            "name": category,
            "pct": sum(pcts) / len(pcts),
            "confidence": sum(conf_by_category[category]) / len(conf_by_category[category]),
        }
        for category, pcts in pcts_by_category.items()
    ]


async def refresh_standard_classification(db: Session) -> dict:
    """One text-only Gemini call over EVERY component key observed in any
    project's analyses; assign each to a single STANDARD_ACTIVITIES category
    (or drop it) and upsert StandardComponentMapping rows. Global, so new
    photos / new projects reuse the same taxonomy. Re-runnable — unknown keys
    only get added, existing rows keep their (possibly manually corrected)
    values. Returns {"classified": n, "total_keys": m}."""
    keys: set = set()
    for a in db.query(AIAnalysis).all():
        if a.components:
            keys.update(a.components.keys())
    total = len(keys)
    if not total:
        return {"classified": 0, "total_keys": 0}

    bullets = "\n".join(f"- {n}" for n in STANDARD_ACTIVITIES)
    labels = json.dumps(sorted(keys))
    prompt = f"""\
You are mapping computer-vision component labels detected in construction/
interior site photos to a standard activity catalog. For each label pick the
SINGLE category it most strongly indicates — visual evidence relevant to that
category. If a label fits no category (e.g. a generic or ambiguous term),
omit it entirely.

Standard categories:
{bullets}

Component labels:
{labels}

Respond ONLY with a JSON object. Each key is a component label; each value
is an object: {{"activity": "<exact category name from the list>",
"confidence": <0.0-1.0>}}. Omit labels that fit no category.
"""
    try:
        response = await _get_client().aio.models.generate_content(
            model="gemini-2.5-flash",
            contents=[prompt],
            config=types.GenerateContentConfig(response_mime_type="application/json"),
        )
        data = json.loads(response.text)
    except Exception as e:
        print(f"refresh_standard_classification error: {e}")
        return {"classified": 0, "total_keys": total}

    category_set = set(STANDARD_ACTIVITIES)
    existing = {r.component_key: r for r in db.query(StandardComponentMapping).all()}
    classified = 0
    now = datetime.utcnow()
    for key, entry in (data or {}).items():
        if isinstance(entry, dict):
            category = entry.get("activity")
            confidence = entry.get("confidence")
        elif isinstance(entry, str):
            category, confidence = entry, 0.9
        else:
            continue
        if not category or category not in category_set or key not in keys:
            continue
        row = existing.get(key)
        if row:
            # Never downgrade an existing row on refresh — keep manual fixes.
            row.category = category
            row.updated_at = now
        else:
            db.add(StandardComponentMapping(
                component_key=key, category=category,
                confidence=float(confidence or 0.9),
            ))
        classified += 1
    db.commit()
    return {"classified": classified, "total_keys": total}


def seed_standard_from_activity_mappings(project_id: str, db: Session) -> int:
    """One-time migration helper: copy a project's existing AI-classified
    mappings (component_key -> standard activity, produced by the older
    per-project standard-plan flow) into the global StandardComponentMapping
    table, so the project's plan can be freed back to its Activity-Excel BoQ
    view without re-running Gemini. Idempotent — existing global rows keep
    the higher confidence."""
    rows = (
        db.query(ActivityMapping)
        .filter(ActivityMapping.project_id == project_id, ActivityMapping.source == "ai")
        .all()
    )
    existing = {r.component_key: r for r in db.query(StandardComponentMapping).all()}
    created = 0
    for m in rows:
        category = m.activity.name if m.activity else None
        if not category or category not in STANDARD_ACTIVITIES:
            continue
        row = existing.get(m.component_key)
        if row:
            if m.confidence and m.confidence > (row.confidence or 0.0):
                row.confidence = m.confidence
            continue
        db.add(StandardComponentMapping(
            component_key=m.component_key, category=category,
            confidence=m.confidence or 0.9,
        ))
        created += 1
    db.commit()
    return created
