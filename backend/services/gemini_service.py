import asyncio
import io
import json
import os
import random
import re
from typing import List, Literal, Optional, Tuple

from dotenv import load_dotenv
from google import genai
from google.genai import types
from PIL import Image, ImageOps
from pydantic import BaseModel, Field

load_dotenv()

# Models are configurable from .env so switching never needs a code edit —
# editing this file under `uvicorn --reload` restarts the server and kills any
# analysis job that is mid-run. GEMINI_FALLBACK_MODELS are tried in order when
# the main model is overloaded (503s are common at peak demand) or retired
# (404 — gemini-2.5-flash was), so analysis keeps working either way.
GEMINI_MODEL = os.getenv("GEMINI_MODEL") or "gemini-3.8-flash"
GEMINI_FALLBACK_MODELS = [
    m.strip() for m in (os.getenv("GEMINI_FALLBACK_MODELS") or "gemini-3.6-flash,gemini-3.5-flash").split(",")
    if m.strip()
]

# Built lazily — constructing genai.Client() at import time raises if no key is
# configured, which used to crash the whole server on boot even for callers
# (like the mobile app) that never touch AI analysis.
_client = None


def _get_client():
    global _client
    if _client is None:
        api_key = os.getenv("gemini_api_key")
        if not api_key:
            raise RuntimeError("gemini_api_key is not configured")
        _client = genai.Client(api_key=api_key)
    return _client


def slugify_activity(name: str) -> str:
    """'Commercial Tiles' -> 'commercial_tiles' — normalises any free-text name
    into the lowercase_underscore keys stored in AIAnalysis.components."""
    slug = re.sub(r"[^a-z0-9]+", "_", name.strip().lower()).strip("_")
    return slug or "activity"


# ── Structured output schema ──────────────────────────────────────────────────
# Passed to Gemini as response_schema, so the reply is guaranteed to be this
# shape (no more free-form JSON that sometimes doesn't parse).

Severity = Literal["low", "medium", "high", "critical"]


class ComponentFinding(BaseModel):
    name: str = Field(description="short lowercase_underscore name, e.g. floor_tiles, false_ceiling, door_frame")
    pct: int = Field(description="estimated completion 0-100")
    confidence: float = Field(description="0.0-1.0, how sure you are of this estimate")
    status: Literal["not_started", "in_progress", "completed"]
    observation: str = Field(description="one short sentence on what you see")


class DefectFinding(BaseModel):
    type: str = Field(description="short lowercase_underscore defect type, e.g. crack, damp_patch, paint_defect")
    description: str
    severity: Severity
    location: str = Field(description="where it is, e.g. 'left wall below the window', 'ceiling above the door'")
    recommendation: str = Field(description="what should be done to fix it")


class SafetyFinding(BaseModel):
    description: str
    severity: Severity


class ImageQuality(BaseModel):
    usable: bool = Field(description="false if the photo is too blurry/dark/obstructed to judge the room")
    issues: List[str] = Field(description="e.g. 'blurry', 'too dark', 'view obstructed'; empty if none")


class SiteAnalysis(BaseModel):
    room_type: str = Field(description="what kind of space this is, e.g. 'bedroom', 'bathroom', 'corridor', 'office'")
    summary: str = Field(description="2-3 sentences: overall state, main progress, main concerns")
    overall_pct: int = Field(description="overall completion of the visible space, 0-100")
    overall_confidence: float = Field(description="0.0-1.0")
    components: List[ComponentFinding]
    defects: List[DefectFinding]
    safety_issues: List[SafetyFinding]
    materials_finishes: List[str] = Field(description="materials/finishes visible, e.g. 'vitrified floor tiles'")
    pending_work: List[str] = Field(description="concrete remaining tasks visible, e.g. 'install skirting'")
    housekeeping: Literal["clean", "moderate", "cluttered"]
    image_quality: ImageQuality


def build_prompt(room_label: Optional[str] = None, is_360: bool = False) -> str:
    """Open-vocabulary inspection prompt. Components are named freely (nothing
    hardcoded); services/mapping_service.py maps them to each project's
    activities afterwards, so re-mapping never requires re-running AI."""
    context = []
    if room_label:
        context.append(f"Location in the project: {room_label}.")
    if is_360:
        context.append(
            "This is a 360-degree equirectangular panorama: the whole room is visible in one image. "
            "The left and right edges join up; the top band is the ceiling and the bottom band is the "
            "floor, both stretched by the projection — judge them with that distortion in mind."
        )
    context_text = "\n".join(context)

    return f"""
You are an experienced construction and interior fit-out site inspector (snagging inspector).
Analyse this site photo carefully and report only what is actually visible.
{context_text}

1. COMPONENTS — identify every distinct construction / fit-out element you can see
   (for example flooring, wall finish, paint, ceiling, doors, windows, glazing, cabinetry,
   wardrobes, electrical points, switches, lighting, plumbing, sanitaryware, hardware,
   skirting — but do not limit yourself to this list). For each: estimated completion %,
   confidence 0-1, status, and one short observation.
   - fully done and clean: 100; partly done: 10-90; just started: 10-30.

2. DEFECTS / SNAGS — inspect closely and list every visible defect, for example:
   cracks (walls, ceiling, tiles), damp patches / seepage / water stains, paint defects
   (patchy, peeling, drips, uneven coverage), chipped / misaligned / lipping tiles or
   uneven grout, gaps and poor joints (skirting, cornice, door and window frames),
   damaged or missing fittings, unfinished edges, exposed or loose wiring,
   dents / scratches / stains on finished surfaces, alignment or level problems.
   Give each a severity, where it is, and how to fix it.
   Severity: low = cosmetic; medium = needs fixing before handover; high = affects
   function or durability; critical = safety risk or major rework.

3. SAFETY — hazards such as exposed live wiring, open shafts or edges without guarding,
   trip hazards, unsafe ladders or scaffolding, blocked exits, missing PPE on workers.

4. MATERIALS & FINISHES visible, PENDING WORK still to do, and HOUSEKEEPING level.

5. IMAGE QUALITY — say if the photo is blurry, dark or obstructed.

Rules: do not invent anything that is not visible. An empty list is a valid answer.
Keep every text field short and specific. If the photo is not a construction or
interior site, mark image_quality.usable = false and keep confidence low.
"""


# ── Image preparation ─────────────────────────────────────────────────────────
# THETA X panoramas are ~11000x5500 px / ~10 MB. Sending that as-is is slow and
# wasteful (the model downsamples anyway); 3072px on the long edge keeps a 2:1
# panorama at 3072x1536 — plenty of detail at a fraction of the payload.
MAX_IMAGE_EDGE = 3072


def _prepare_image(image_bytes: bytes) -> bytes:
    img = Image.open(io.BytesIO(image_bytes))
    img = ImageOps.exif_transpose(img)        # respect phone orientation
    if img.mode != "RGB":
        img = img.convert("RGB")
    if max(img.size) > MAX_IMAGE_EDGE:
        img.thumbnail((MAX_IMAGE_EDGE, MAX_IMAGE_EDGE), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=90)
    return buf.getvalue()


# ── Normalisation ─────────────────────────────────────────────────────────────

def _clamp(value, lo, hi, default):
    try:
        return max(lo, min(hi, float(value)))
    except (TypeError, ValueError):
        return default


def _normalise(raw: dict, is_360: bool, model: str) -> Tuple[dict, float, str]:
    """Structured reply -> (data, overall_pct, notes) in the shape the rest of the
    app already stores: components stays a dict of name -> {pct, confidence}
    (mapping_service / activity_catalog read exactly that); everything new
    lives in `details`."""
    components = {}
    for c in raw.get("components") or []:
        name = slugify_activity(str(c.get("name", "")))
        entry = {
            "pct": round(_clamp(c.get("pct"), 0, 100, 0)),
            "confidence": round(_clamp(c.get("confidence"), 0, 1, 0.5), 2),
            "status": c.get("status") or "in_progress",
            "note": (c.get("observation") or "").strip(),
        }
        # Same element named twice: keep the more confident reading.
        if name not in components or entry["confidence"] > components[name]["confidence"]:
            components[name] = entry

    severities = ("low", "medium", "high", "critical")

    def sev(v):
        return v if v in severities else "medium"

    defects = [
        {
            "type": slugify_activity(str(d.get("type", "defect"))),
            "description": (d.get("description") or "").strip(),
            "severity": sev(d.get("severity")),
            "location": (d.get("location") or "").strip(),
            "recommendation": (d.get("recommendation") or "").strip(),
        }
        for d in raw.get("defects") or [] if (d.get("description") or "").strip()
    ]
    safety = [
        {"description": (s.get("description") or "").strip(), "severity": sev(s.get("severity"))}
        for s in raw.get("safety_issues") or [] if (s.get("description") or "").strip()
    ]
    quality = raw.get("image_quality") or {}
    summary = (raw.get("summary") or "").strip()
    overall_pct = round(_clamp(raw.get("overall_pct"), 0, 100, 0), 1)

    details = {
        "room_type": (raw.get("room_type") or "").strip(),
        "summary": summary,
        "overall_confidence": round(_clamp(raw.get("overall_confidence"), 0, 1, 0.5), 2),
        "defects": defects,
        "safety_issues": safety,
        "materials_finishes": [m.strip() for m in raw.get("materials_finishes") or [] if str(m).strip()],
        "pending_work": [w.strip() for w in raw.get("pending_work") or [] if str(w).strip()],
        "housekeeping": raw.get("housekeeping") if raw.get("housekeeping") in ("clean", "moderate", "cluttered") else None,
        "image_quality": {
            "usable": bool(quality.get("usable", True)),
            "issues": [i for i in quality.get("issues") or [] if str(i).strip()],
        },
        "analysed_as_360": is_360,
        "model": model,            # which model actually produced this (may be a fallback)
    }
    return {"components": components, "details": details, "overall_pct": overall_pct}, overall_pct, summary


# ── Gemini call ───────────────────────────────────────────────────────────────
CALL_TIMEOUT_SECONDS = 180      # a hung request must not freeze an analysis job forever
ATTEMPTS_PER_MODEL = 2
_TRANSIENT = ("429", "500", "502", "503", "504", "RESOURCE_EXHAUSTED", "UNAVAILABLE",
              "DEADLINE_EXCEEDED", "INTERNAL", "overloaded", "timed out")


def _is_transient(err: Exception) -> bool:
    if isinstance(err, asyncio.TimeoutError):
        return True
    text = f"{type(err).__name__}: {err}"
    return any(marker in text for marker in _TRANSIENT)


def _is_model_gone(err: Exception) -> bool:
    text = str(err)
    return "404" in text and ("NOT_FOUND" in text or "no longer available" in text)


async def analyse_image(image_bytes: bytes, media_type: Optional[str] = None,
                        room_label: Optional[str] = None):
    """Returns (data, overall_pct, notes). On failure returns ({}, 0, "Error: ...")
    — callers treat an empty `data` as a failed analysis (never as 0% progress).

    Transient failures (rate limits, overload, timeouts) are retried with
    backoff, then the next model in GEMINI_FALLBACK_MODELS is tried; a retired
    model (404) moves on immediately. Anything else (bad key, bad image) fails
    at once, since another attempt would fail the same way."""
    is_360 = media_type == "360"
    try:
        prepared = _prepare_image(image_bytes)
    except Exception as e:
        print(f"Gemini Error: could not read image: {e}")
        return {}, 0, f"Error: could not read image ({e})"

    config = types.GenerateContentConfig(
        response_mime_type="application/json",
        response_schema=SiteAnalysis,
        media_resolution=types.MediaResolution.MEDIA_RESOLUTION_HIGH,  # keep fine detail like hairline cracks
        temperature=0.2,                                               # consistent readings across visits
    )
    contents = [
        build_prompt(room_label, is_360),
        types.Part.from_bytes(data=prepared, mime_type="image/jpeg"),
    ]

    try:
        response, model = await _generate_with_fallback(contents, config)
        print("---------- GEMINI RESPONSE ----------")
        print(response.text)
        print("-------------------------------------")
        return _normalise(json.loads(response.text), is_360, model)
    except Exception as e:
        message = "request timed out" if isinstance(e, asyncio.TimeoutError) else str(e)
        print(f"Gemini Error: {message}")
        return {}, 0, f"Error: {message}"


async def _generate_with_fallback(contents, config):
    """One generate_content call with retries + model fallback. Returns
    (response, model_used); raises the last error if every model failed."""
    models = list(dict.fromkeys([GEMINI_MODEL, *GEMINI_FALLBACK_MODELS]))   # ordered, no duplicates
    last_error = None
    for model in models:
        for attempt in range(1, ATTEMPTS_PER_MODEL + 1):
            try:
                response = await asyncio.wait_for(
                    _get_client().aio.models.generate_content(model=model, contents=contents, config=config),
                    timeout=CALL_TIMEOUT_SECONDS,
                )
                usage = getattr(response, "usage_metadata", None)
                if usage:
                    print(f"Gemini usage: input={usage.prompt_token_count} output={usage.candidates_token_count} "
                          f"total={usage.total_token_count} model={model}")
                return response, model
            except Exception as e:
                last_error = e
                if _is_model_gone(e):
                    print(f"Gemini model {model} is not available (retired?) - trying the next model")
                    break
                if not _is_transient(e):
                    raise
                if attempt < ATTEMPTS_PER_MODEL:
                    wait = 2 ** attempt + random.uniform(0, 1)
                    print(f"Gemini {model} busy (attempt {attempt}/{ATTEMPTS_PER_MODEL}), retrying in {wait:.0f}s: {e}")
                    await asyncio.sleep(wait)
                else:
                    print(f"Gemini {model} still unavailable - trying the next model")
    raise last_error


async def generate_json(prompt: str) -> dict:
    """Text-only JSON call (component mapping / category classification) with
    the same retries and model fallback as image analysis. Raises on failure."""
    response, _ = await _generate_with_fallback(
        [prompt], types.GenerateContentConfig(response_mime_type="application/json"),
    )
    return json.loads(response.text)


def compute_change_flag(previous_pct: Optional[float], current_pct: float, threshold: float = 5.0) -> Tuple[float, str]:
    if previous_pct is None:
        return 0.0, "new"

    delta = round(current_pct - previous_pct, 1)

    if delta > threshold:
        flag = "progress"
    elif delta < -threshold:
        flag = "rework"
    elif abs(delta) <= 2:
        flag = "stalled"
    else:
        flag = "progress"

    return delta, flag
