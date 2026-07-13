from sqlalchemy import create_engine, text, inspect
from sqlalchemy.orm import sessionmaker
from .database import Base
from config import settings

engine = create_engine(settings.DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def _migrate_add_missing_columns():
    """
    create_all() only creates brand-new tables — it never alters existing ones.
    This adds columns that were added to models after the table already existed
    (e.g. Project.site_floors) so a live DB doesn't need a full migration tool for it.
    """
    inspector = inspect(engine)
    if "projects" not in inspector.get_table_names():
        return
    existing_cols = {c["name"] for c in inspector.get_columns("projects")}
    if "site_floors" not in existing_cols:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE projects ADD site_floors NVARCHAR(MAX) NULL"))


def init_db():
    Base.metadata.create_all(bind=engine)
    _migrate_add_missing_columns()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
