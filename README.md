# VESTIGIA — Interior Construction Monitoring Platform

**The Verifiable Record of Execution.**

AI-powered construction progress tracking for IEVO. Built for POC demo.

---

## Tech stack

| Layer | Tech |
|---|---|
| Frontend | React 18 + Vite + Tailwind + Recharts + Three.js |
| Backend | FastAPI + SQLAlchemy |
| AI | Google Gemini 2.5 Flash (multimodal image analysis) |
| Database | MS SQL Server (via pyodbc) |
| Storage | Google Cloud Storage (local `./uploads/` fallback for POC) |

---

## Setup

### Prerequisites
- Python 3.11+ (with a working SQL Server ODBC driver installed)
- Node 20+
- MS SQL Server instance reachable from `DATABASE_URL`

### Backend

```bash
cd backend
python -m venv venv
venv\Scripts\activate        # macOS/Linux: source venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# Edit .env — set DATABASE_URL and gemini_api_key at minimum

uvicorn main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173` (frontend) and `http://localhost:8000/docs` (API docs).

---

## Environment variables (`backend/.env`)

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | SQL Server connection string (`mssql+pyodbc://...`) |
| `gemini_api_key` | Yes | Google Gemini API key |
| `SECRET_KEY` | Yes | JWT signing key — change in prod |
| `GCS_BUCKET_NAME` / `GCS_PROJECT_ID` / `GOOGLE_APPLICATION_CREDENTIALS` | No | GCS storage (falls back to `./uploads/` if unset) |
| `CORS_ORIGINS` | No | Comma-separated allowed origins |

---

## Core workflow

1. **Register / Sign in** (`/register`, `/login`). All API routes below (except `/auth/*`) require a Bearer JWT.
2. **Projects** → create a project, then build its hierarchy: Floor → Room ID (Unit) → Area (Room). This hierarchy is the single source of truth for every other page.
3. **Activity Plan** *(Projects page)* → define the list of activities to track for a project (e.g. "Commercial Tiles", "Wall Panelling"), either by uploading an Excel/CSV (activity name column + an optional target/deadline date column, flexible header matching) or adding them manually. Each activity can carry a planned completion date, used later for delay tracking. If a project has no Activity Plan, AI analysis falls back to a default furniture-category list.
4. **Upload** → pick a room, drag photos → Gemini analyses each one in the background (~5–10s), scoring completion % against the project's Activity Plan (or the default categories).
5. **AI analysis** → radar chart, progress-over-time, change-detection flags (`progress` / `stalled` / `rework`) per room.
6. **Floor view** → room heatmap, auto-updated after every analysis. A newer "Internal Floorwise Summary" layout is available via an in-page toggle (persisted per browser).
7. **Executive** → two dashboards behind a toggle (persisted per browser):
   - **Classic** — overall progress, weekly trend, floor-wise bar chart, floor breakdown table.
   - **New (activity-based)** — reads the project's Activity Plan and scores every Location (Floor + Room ID/Unit) against each activity. Includes KPI row (Overall/Completed/In Progress/Not Started/Cannot Assess/**Delayed**/Locations Processed/Total Activities), Activity Completion bars (with target-date + delay flags), a status Summary donut, Weekly progress trend, Completion by Location (horizontally scrollable for many locations), an Activity Details modal (full activity × location matrix with status filters + search), and CSV export. "Delayed" = activity has a target date in the past and isn't yet ≥95% complete.
8. **Layout Setup** → per floor, upload a floor plan image/PDF and pin hotspots; each hotspot is mapped to a real Room ID → Area picked live from the Projects hierarchy (no duplicate data entry).
9. **Site Capture** → pick a floor, tap a pinned hotspot, attach a photo. The photo is saved permanently to the backend (auto-timestamped) against that hotspot's real Room.
10. **Panorama** *(Site Photo Viewer)* → filter Floor → Room ID → Room Name → Date to pull up a captured photo; **Split Comparison** shows two independently-filtered photos side by side.

Progress rollup (room → unit → floor → project) recalculates automatically after every upload.

---

## API endpoints

```
POST   /auth/register                        Register user (returns JWT)
POST   /auth/login                            Login (returns JWT)

GET    /projects                              List projects
POST   /projects                              Create project
GET    /projects/{id}/dashboard               Executive dashboard data (classic)
GET    /projects/{id}/activities              Get a project's Activity Plan ([{name, target_date}])
PUT    /projects/{id}/activities              Set a project's Activity Plan
POST   /projects/{id}/floors                  Add floor
GET    /projects/{id}/floors                  List floors
POST   /projects/floors/{id}/units            Add Room ID (Unit)
GET    /projects/floors/{id}/units            List Room IDs
POST   /projects/units/{id}/rooms             Add Area (Room)
GET    /projects/units/{id}/rooms             List Areas

POST   /uploads                               Upload media (triggers AI in background)
GET    /uploads/room/{id}                     List a room's uploads

GET    /analysis/room/{id}/latest             Latest AI result
GET    /analysis/room/{id}/change-detection   Full history

/site/*                                       Layout Setup / Site Capture / Panorama (floor plans, hotspots, captures)
/mobile/*                                     Mobile app sync endpoints (offline-first spot/photo sync)
```

Full interactive docs at `http://localhost:8000/docs`.

---

## Known gaps (POC)

- `/mobile/*` and `/auth/*` routes are not behind the JWT dependency (mobile handles its own auth flow separately); every other router (`/projects`, `/uploads`, `/analysis`, `/site`) enforces a Bearer JWT.
- No update/delete endpoints for the Floor/Unit/Room hierarchy — append-only via the API.
- The old 3D 360° sphere panorama viewer was replaced by the Site Photo Viewer (Floor/Room/Date filters) — Three.js is still a dependency but no longer used on that page.
- Activity Plan completion % is only ever computed from real AI analyses — an activity/location combo with no matching analysis shows "Cannot Assess", never a fabricated number.
