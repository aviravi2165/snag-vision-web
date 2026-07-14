from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from config import settings
from models import init_db, SessionLocal
from routers import auth, projects, uploads, analysis, mobile, site
from seed import seed_demo_data

app = FastAPI(
    title="SnagVision — Interior Construction Monitoring API",
    version="1.0.0",
    description="AI-powered interior construction progress tracking for IEVO",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(projects.router)
app.include_router(uploads.router)
app.include_router(analysis.router)
app.include_router(mobile.router)
app.include_router(site.router)

# Serve local uploads (POC fallback when GCS not configured)
uploads_dir = Path("./uploads")
uploads_dir.mkdir(exist_ok=True)
app.mount("/uploads", StaticFiles(directory="uploads"), name="uploads")


@app.on_event("startup")
def on_startup():
    init_db()
    db = SessionLocal()
    try:
        seed_demo_data(db)
    finally:
        db.close()


@app.get("/health")
def health():
    return {"status": "ok", "service": "SnagVision API"}
