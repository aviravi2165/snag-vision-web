import base64
import io
import json
import re
from PIL import Image
from typing import List, Optional, Tuple
from google import genai
from google.genai import types
from config import settings
import asyncio
import os
from dotenv import load_dotenv


load_dotenv()

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

# Fallback component list — only used by build_prompt()'s legacy activity_names
# path below, kept for backward compatibility with older direct callers.
DEFAULT_ACTIVITIES = [
    "design_approval", "carpentry_frame", "polishing_painting",
    "upholstery_work", "hardware_fitting", "packaging_delivery", "site_installation",
]


def slugify_activity(name: str) -> str:
    """'Commercial Tiles' -> 'commercial_tiles' — used as the JSON key so an
    Activity Plan of free-text names still round-trips through the DB's
    dict-of-numbers `components` column the rest of the app already expects."""
    slug = re.sub(r"[^a-z0-9]+", "_", name.strip().lower()).strip("_")
    return slug or "activity"


def build_prompt(activity_names: Optional[List[str]] = None) -> str:
    """Builds the Gemini prompt.

    Open-vocabulary mode (default, activity_names=None): Gemini freely detects
    whatever construction/interior components it visually recognizes in the
    photo (its own vocabulary — nothing hardcoded here) and scores each with a
    confidence. This decouples vision output from any one project's activity
    names — a separate per-project mapping (services/mapping_service.py)
    translates components -> activities at aggregation time, so re-mapping
    never requires re-running AI. See system-wide architecture notes in
    services/mapping_service.py.

    Legacy mode (activity_names passed): scores directly against the given
    activity names instead — kept only for any caller still using the older
    direct-activity-name flow.
    """
    if activity_names:
        keys = [slugify_activity(n) for n in activity_names]
        schema_lines = ",\n".join(f'  "{k}": <0-100 or null>' for k in keys)
        bullet_lines = "\n".join(f"- {n}" for n in activity_names)
        return f"""
You are an expert construction/interior-fit-out progress inspector.
Analyse the provided site photo. Estimate the completion percentage for each
activity below, based only on visible evidence in the image.

Activities to evaluate:
{bullet_lines}

Evaluation Rules:
- clearly visible and 100% done: 100
- partially done: estimate 10-90
- minimal work: 10-30
- not visible / not applicable in this photo: null

Respond ONLY with a valid JSON object matching this schema:
{{
{schema_lines},
  "overall_pct": <0-100>,
  "notes": "string description"
}}
"""

    return """
You are an expert construction/interior-fit-out progress inspector.
Analyse the provided site photo. Freely identify every distinct construction
or interior-fit-out component you can visually recognize in the image (for
example: flooring material, wall finish, paint, ceiling work, doors, windows,
glass, cabinetry, wardrobes, electrical fittings, plumbing fixtures, hardware,
lighting — but do NOT limit yourself to this list; use whatever specific,
short, lowercase, underscore-separated component name best matches what you
actually see). For each component you identify, estimate its completion
percentage and how confident you are in that estimate.

Evaluation Rules:
- clearly visible and 100% done: pct 100
- partially done: pct 10-90
- minimal work started: pct 10-30
- confidence: 0.0-1.0, how sure you are of this specific estimate
- do not invent components that aren't visible in the photo

Respond ONLY with a valid JSON object matching this schema:
{
  "components": {
    "<component_name>": {"pct": <0-100>, "confidence": <0.0-1.0>},
    ...
  },
  "overall_pct": <0-100, overall estimated completion of the room shown>,
  "notes": "string description"
}
"""

# 1. 'async def' lagaya taaki 'await' kaam kare.
# 2. '*args' aur '**kwargs' lagaya taaki uploads.py jo extra 2 arguments bhej raha hai usse error na aaye.
# 3. 'activity_names' — legacy path only (see build_prompt docstring); omit it
#    (default) to get open-vocabulary component detection.
async def analyse_image(image_b64, *args, activity_names: Optional[List[str]] = None, **kwargs):
    prompt = build_prompt(activity_names)
    try:
        # Check agar input bytes hai
        if isinstance(image_b64, bytes):
            # Agar string bytes mein hai (e.g. b'data:image/png;base64,...')
            if image_b64.startswith(b'data:'):
                # Bytes ko string mein badalne ke liye 'latin-1' safe encoding hai
                temp_str = image_b64.decode('latin-1') 
                if "," in temp_str:
                    image_data = temp_str.split(",")[1]
                    image_bytes = base64.b64decode(image_data)
                else:
                    image_bytes = base64.b64decode(image_b64)
            else:
                # Agar seedha raw binary image hai
                image_bytes = image_b64
        else:
            # Agar string input hai
            if "," in image_b64:
                image_b64 = image_b64.split(",")[1]
            image_bytes = base64.b64decode(image_b64)

        # Image load karo
        image = Image.open(io.BytesIO(image_bytes))
        
        MAX_RETRIES = 5
        
        for attempt in range(MAX_RETRIES):
            try:
                response = await _get_client().aio.models.generate_content(
                    model='gemini-2.5-flash', # Yahan check kar lena model name correct ho
                    contents=[prompt, image],
                    config=types.GenerateContentConfig(
                        response_mime_type="application/json"
                    )
                )
                
                print("---------- GEMINI RESPONSE ----------")
                print(response.text)
                print("-------------------------------------")
                
                data = json.loads(response.text)
                
                return (
                    data,
                    data.get("overall_pct", 0),
                    data.get("notes", "")
                )
                
            except Exception as e:
                if "503" in str(e) and attempt < MAX_RETRIES - 1:
                    wait_time = 2 ** attempt
                    print(f"Gemini busy. Retrying in {wait_time} seconds...")
                    await asyncio.sleep(wait_time)
                else:
                    raise

    except Exception as e:
        print(f"Gemini Error: {str(e)}")
        return {}, 0, f"Error: {str(e)}"
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