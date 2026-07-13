# SnagVision— Interior Construction Monitoring Platform

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

1. **Register / Sign in** (`/register`, `/login`).
2. **Projects** → create a project, then build its hierarchy: Floor → Room ID (Unit) → Area (Room). This hierarchy is the single source of truth for every other page.
3. **Upload** → pick a room, drag photos → Gemini analyses each one in the background (~5–10s) and returns a component-level completion breakdown.
4. **AI analysis** → radar chart, progress-over-time, change-detection flags (`progress` / `stalled` / `rework`) per room.
5. **Floor view** → room heatmap, auto-updated after every analysis.
6. **Executive** → overall progress, floor chart, delay tracker.
7. **Layout Setup** → per floor, upload a floor plan image/PDF and pin hotspots; each hotspot is mapped to a real Room ID → Area picked live from the Projects hierarchy (no duplicate data entry).
8. **Site Capture** → pick a floor, tap a pinned hotspot, attach a photo. The photo is saved permanently to the backend (auto-timestamped) against that hotspot's real Room.
9. **Panorama** *(Site Photo Viewer)* → filter Floor → Room ID → Room Name → Date to pull up a captured photo; **Split Comparison** shows two independently-filtered photos side by side.

Progress rollup (room → unit → floor → project) recalculates automatically after every upload.

---

## API endpoints

```
POST   /auth/register                        Register user (returns JWT)
POST   /auth/login                            Login (returns JWT)

GET    /projects                              List projects
POST   /projects                              Create project
GET    /projects/{id}/dashboard               Executive dashboard data
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
```

Full interactive docs at `http://localhost:8000/docs`.

---

## Known gaps (POC)

- No route currently enforces JWT auth (tokens are issued but not verified).
- No update/delete endpoints for the Floor/Unit/Room hierarchy — append-only via the API.
- The old 3D 360° sphere panorama viewer was replaced by the Site Photo Viewer (Floor/Room/Date filters) — Three.js is still a dependency but no longer used on that page.
