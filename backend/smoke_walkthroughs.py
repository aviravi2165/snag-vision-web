"""
End-to-end smoke test for the unified media pipeline (walkthroughs).

Runs the real FastAPI app against a throwaway SQLite file with the Gemini call
stubbed (so the background job worker completes without hitting the paid API),
then drives the exact flows from the plan's verification section over HTTP.

Run:  python smoke_walkthroughs.py        (from backend/)
"""
import os
import sys
import time
from pathlib import Path

DB_PATH = Path("./_smoke_walkthroughs.db")
DB_PATH.unlink(missing_ok=True)  # always start from a fresh DB
os.environ["DATABASE_URL"] = f"sqlite:///{DB_PATH}"
os.environ["CHROMA_HOST"] = "localhost"
os.environ["CHROMA_PORT"] = "8000"
os.environ["CORS_ORIGINS"] = "http://localhost:5173"

# Stub Gemini BEFORE importing the app — the worker must never hit the real API.
import services.job_worker as job_worker_mod

async def _fake_analyse(image_bytes, media_type, room_name, activity_names=None):
    return {"components": {"flooring": 55, "painting": 45}}, 55.0, "smoke-test analysis"

job_worker_mod.analyse_image = _fake_analyse

from fastapi.testclient import TestClient  # noqa: E402
import main  # noqa: E402
from models import SessionLocal, engine  # noqa: E402
from models.database import HotspotCapture, MediaUpload  # noqa: E402

# Minimal valid JPEG generated with Pillow so image-processing code paths accept it.
import io  # noqa: E402
from PIL import Image  # noqa: E402
_buf = io.BytesIO()
Image.new("RGB", (8, 8), color=(120, 80, 60)).save(_buf, format="JPEG")
JPEG = _buf.getvalue()

UPLOADS_DIR = Path("./uploads")
UPLOADS_DIR.mkdir(exist_ok=True)
_PRE_EXISTING_UPLOADS = {f.name for f in UPLOADS_DIR.iterdir()}

FAILURES = []

def check(cond, msg):
    if cond:
        print(f"  ok  {msg}")
    else:
        FAILURES.append(msg)
        print(f"  FAIL {msg}")

def upload_file(client, headers, url, filename, room_id=None, supervisor_id=None):
    data = {}
    files = {"file": (filename, JPEG, "image/jpeg")}
    if room_id:
        data["room_id"] = room_id
        data["supervisor_id"] = supervisor_id or ""
    return client.post(url, data=data, files=files, headers=headers)

def site_capture(client, headers, hotspot_id, filename):
    return client.post(
        f"/site/hotspots/{hotspot_id}/capture",
        files={"file": (filename, JPEG, "image/jpeg")},
        headers=headers,
    )

def run():
    with TestClient(main.app) as c:
        r = c.post("/auth/register", json={"name": "Smoke", "email": "smoke@example.com", "password": "secret123"})
        check(r.status_code in (200, 201), "register user")
        token = r.json()["access_token"]
        user_id = r.json()["user"]["id"]
        H = {"Authorization": f"Bearer {token}"}

        pid = c.get("/projects", headers=H).json()[0]["id"]
        fid = c.get(f"/projects/{pid}/floors", headers=H).json()[0]["id"]
        lobby = c.get(f"/projects/floors/{fid}/rooms", headers=H).json()[0]

        # Second room via the Unit path (also exercises unit-parented project derivation)
        unit = c.post(f"/projects/floors/{fid}/units", json={"unit_number": "A-2"}, headers=H).json()
        suite = c.post(f"/projects/units/{unit['id']}/rooms", json={"name": "Suite"}, headers=H).json()

        hs_a = c.post(f"/site/projects/{pid}/hotspots", json={
            "floor_number": 1, "x_pct": 0.2, "y_pct": 0.3,
            "room_id": lobby["id"], "room_name": lobby["name"],
        }, headers=H).json()
        hs_b = c.post(f"/site/projects/{pid}/hotspots", json={
            "floor_number": 1, "x_pct": 0.6, "y_pct": 0.4,
            "room_id": suite["id"], "room_name": suite["name"],
        }, headers=H).json()

        # ── 1. No walkthrough yet: every capture path 400 ──
        check(upload_file(c, H, "/uploads", "a.jpg", room_id=lobby["id"], supervisor_id=user_id).status_code == 400,
              "POST /uploads 400 with no active walkthrough")
        check(site_capture(c, H, hs_a["id"], "a.jpg").status_code == 400,
              "site capture 400 with no active walkthrough")

        # ── 2. Explicit create; second create while one is active rejected ──
        r = c.post(f"/projects/{pid}/walkthroughs", headers=H)
        check(r.status_code == 201 and r.json()["number"] == 1 and r.json()["status"] == "draft",
              "create walkthrough 1 (draft)")
        wt1_id = r.json()["id"]
        check(c.post(f"/projects/{pid}/walkthroughs", headers=H).status_code == 400,
              "second create while one active -> 400")
        check(c.get(f"/projects/{pid}/walkthroughs/current", headers=H).json()["id"] == wt1_id,
              "GET current -> walkthrough 1")

        # ── 3. First capture via Site Capture: canonical MediaUpload + pointer; draft -> capturing ──
        check(site_capture(c, H, hs_a["id"], "lobby.jpg").status_code == 201, "site capture -> 201")
        caps = c.get(f"/site/hotspots/{hs_a['id']}/capture", headers=H).json()
        check(caps.get("media_upload_id"), "HotspotCapture links to the canonical MediaUpload")
        check(c.get(f"/projects/{pid}/walkthroughs/current", headers=H).json()["status"] == "capturing",
              "walkthrough draft -> capturing on first capture")

        # ── 4. Media manager grouping + summary ──
        mm = c.get(f"/uploads/project/{pid}", headers=H).json()
        check(len(mm["groups"]) == 1 and mm["groups"][0]["label"] == "Walkthrough 1",
              "media manager: one group")
        check(mm["groups"][0]["summary"] == {"total": 1, "pending": 1, "done": 0, "failed": 0},
              "media manager summary {total:1, pending:1}")

        # ── 5. request-complete warns about the pinned-but-uncaptured room ──
        r = c.post(f"/walkthroughs/{wt1_id}/request-complete", headers=H)
        check(r.status_code == 200 and r.json()["walkthrough"]["status"] == "ready_to_complete",
              "request-complete -> ready_to_complete")
        warns = r.json()["warnings"]
        check(len(warns) == 1 and warns[0]["room_id"] == suite["id"],
              "warnings name the expected-but-uncaptured room")

        # ── 6. New capture while ready_to_complete auto-reverts to capturing ──
        check(site_capture(c, H, hs_b["id"], "suite.jpg").status_code == 201, "site capture (suite) -> 201")
        cur = c.get(f"/projects/{pid}/walkthroughs/current", headers=H).json()
        check(cur["status"] == "capturing" and cur["ready_at"] is None,
              "ready_to_complete -> capturing on new capture")

        # ── 7. request-complete again clean -> confirm complete ──
        r = c.post(f"/walkthroughs/{wt1_id}/request-complete", headers=H)
        check(r.status_code == 200 and r.json()["warnings"] == [],
              "request-complete clean after covering all pinned rooms")
        check(c.post(f"/walkthroughs/{wt1_id}/complete", headers=H).json()["status"] == "completed",
              "confirm-complete -> completed")

        # Completed walkthrough is read-only
        check(upload_file(c, H, "/uploads", "late.jpg", room_id=suite["id"], supervisor_id=user_id).status_code == 400,
              "capture into completed walkthrough -> 400")

        # ── 8. Walkthrough-scoped AI analysis; worker flips ai_processing -> ai_completed ──
        r = c.post(f"/projects/{pid}/analysis/start", headers=H)
        check(r.status_code == 202 and r.json()["walkthrough_id"] == wt1_id,
              "analysis start scoped to walkthrough 1")
        job_id = r.json()["id"]
        wts = {w["number"]: w for w in c.get(f"/projects/{pid}/walkthroughs", headers=H).json()}
        check(wts[1]["status"] == "ai_processing", "walkthrough completed -> ai_processing on start")

        job = {}
        for _ in range(30):
            job = c.get(f"/projects/{pid}/analysis/jobs/{job_id}", headers=H).json()
            if job["status"] in ("done", "failed"):
                break
            time.sleep(1)
        check(job["status"] == "done", f"analysis job finishes (status={job['status']})")
        wts = {w["number"]: w for w in c.get(f"/projects/{pid}/walkthroughs", headers=H).json()}
        check(wts[1]["status"] == "ai_completed", "walkthrough ai_processing -> ai_completed when job done")
        mu = c.get(f"/uploads/room/{lobby['id']}", headers=H).json()[0]
        check(mu["status"] == "done", "upload status pending -> done after analysis")

        # ── 9. Walkthrough 2: re-capturing the same room keeps BOTH history rows ──
        r = c.post(f"/projects/{pid}/walkthroughs", headers=H)
        check(r.status_code == 201 and r.json()["number"] == 2, "create walkthrough 2 (number 2)")
        wt2_id = r.json()["id"]

        # Zero-capture walkthrough cannot request completion (hard block)
        check(c.post(f"/walkthroughs/{wt2_id}/request-complete", headers=H).status_code == 400,
              "request-complete with zero captures -> 400")

        # Same hotspot captured again inside walkthrough 2 -> NEW row, old one intact
        check(site_capture(c, H, hs_a["id"], "lobby2.jpg").status_code == 201,
              "re-capture same room in walkthrough 2 -> 201")
        # Manual Upload-page path still works in a capturing walkthrough
        check(upload_file(c, H, "/uploads", "suite2.jpg", room_id=suite["id"], supervisor_id=user_id).status_code == 201,
              "POST /uploads in capturing walkthrough -> 201")

        db = SessionLocal()
        try:
            caps_a = db.query(HotspotCapture).filter(HotspotCapture.hotspot_id == hs_a["id"]).count()
            uploads_2 = db.query(MediaUpload).filter(MediaUpload.walkthrough_id == wt2_id).count()
        finally:
            db.close()
        check(caps_a == 2, "two HotspotCapture rows across the two walkthroughs (append-only, nothing overwritten)")
        check(uploads_2 == 2, "walkthrough 2 has exactly its own captures")

        mm = c.get(f"/uploads/project/{pid}", headers=H).json()
        totals = {g["label"]: g["summary"]["total"] for g in mm["groups"]}
        check(totals == {"Walkthrough 2": 2, "Walkthrough 1": 2},
              f"media manager: two groups with correct totals ({totals})")

        # ── 10. One active walkthrough at a time; numbers never skipped ──
        check(c.post(f"/projects/{pid}/walkthroughs", headers=H).status_code == 400,
              "create walkthrough 3 while 2 active -> 400")

    # Cleanup: dispose the engine so the sqlite file isn't locked, then remove
    # only the artifacts this run created.
    engine.dispose()
    DB_PATH.unlink(missing_ok=True)
    for f in UPLOADS_DIR.iterdir():
        if f.name not in _PRE_EXISTING_UPLOADS:
            f.unlink(missing_ok=True)

    if FAILURES:
        print(f"\n{len(FAILURES)} assertion(s) FAILED")
        sys.exit(1)
    print("\nALL SMOKE CHECKS PASSED")

if __name__ == "__main__":
    run()
