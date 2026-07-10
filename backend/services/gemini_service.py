import base64
import io
import json
from PIL import Image
from typing import Optional, Tuple
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

ANALYSIS_PROMPT = """
You are an expert furniture manufacturing and quality inspector.
Analyse the provided image of a furniture item under construction/installation.
Estimate the completion percentage for each component based on visible evidence.

Components to evaluate:
- design_approval
- carpentry_frame
- polishing_painting
- upholstery_work
- hardware_fitting
- packaging_delivery
- site_installation

Evaluation Rules:
- clearly visible and 100% done: 100
- partially done: estimate 10–90
- minimal work: 10–30
- not visible/not applicable: null

Respond ONLY with a valid JSON object matching this schema:
{
  "design_approval": 100,
  "carpentry_frame": 80,
  "polishing_painting": null,
  "upholstery_work": null,
  "hardware_fitting": null,
  "packaging_delivery": null,
  "site_installation": null,
  "overall_pct": 90,
  "notes": "string description"
}
"""

# 1. 'async def' lagaya taaki 'await' kaam kare.
# 2. '*args' aur '**kwargs' lagaya taaki uploads.py jo extra 2 arguments bhej raha hai usse error na aaye.
async def analyse_image(image_b64, *args, **kwargs):
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
                    contents=[ANALYSIS_PROMPT, image],
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