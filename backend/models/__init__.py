from sqlalchemy import create_engine, text, inspect
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker
from .database import Base
from config import settings

engine = create_engine(settings.DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def _ensure_database_exists():
    """Creates the target database itself if it doesn't exist yet. Without
    this, a fresh machine (e.g. a teammate's PC with SQL Server already
    installed, pointed at their own instance via .env) needs someone to run
    a manual CREATE DATABASE before the app can boot at all — this makes
    `git clone` + `.env` + run sufficient. Only meaningful for MSSQL;
    anything else falls through and create_all() below surfaces a clearer
    error if the database genuinely isn't reachable."""
    url = make_url(settings.DATABASE_URL)
    db_name = url.database
    if not db_name or "mssql" not in url.drivername:
        return
    admin_engine = create_engine(url.set(database="master"))
    try:
        with admin_engine.connect() as conn:
            conn = conn.execution_options(isolation_level="AUTOCOMMIT")
            safe_name = db_name.replace("]", "]]")
            conn.execute(
                text(f"IF DB_ID(:name) IS NULL CREATE DATABASE [{safe_name}]"),
                {"name": db_name},
            )
    except Exception:
        pass
    finally:
        admin_engine.dispose()


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

    if "spots" in inspector.get_table_names():
        spot_cols = {c["name"] for c in inspector.get_columns("spots")}
        if "client_spot_id" not in spot_cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE spots ADD client_spot_id NVARCHAR(64) NULL"))


def _ensure_indexes():
    """Guarantees the filtered unique index on spots.client_spot_id exists.
    The model deliberately omits unique=True on that column (see
    database.py's comment) so create_all() never creates a *plain* unique
    index there — MSSQL treats all NULLs as equal under a plain unique
    index/constraint, so it would only ever allow a single spot with no
    client_spot_id (i.e. one normal, non-offline-synced spot per whole
    database). This filtered index (unique only where the value is
    actually set) is the real uniqueness guard, and always has to be
    created explicitly either way — runs on every boot, cheap no-op once
    correct."""
    inspector = inspect(engine)
    if "spots" not in inspector.get_table_names():
        return
    with engine.begin() as conn:
        row = conn.execute(text(
            "SELECT filter_definition FROM sys.indexes "
            "WHERE object_id = OBJECT_ID('spots') AND name = 'ix_spots_client_spot_id'"
        )).first()
        if row and row[0]:
            return
        if row:
            conn.execute(text("DROP INDEX ix_spots_client_spot_id ON spots"))
        conn.execute(text(
            "CREATE UNIQUE INDEX ix_spots_client_spot_id ON spots(client_spot_id) "
            "WHERE client_spot_id IS NOT NULL"
        ))


def init_db():
    _ensure_database_exists()
    Base.metadata.create_all(bind=engine)
    _migrate_add_missing_columns()
    _ensure_indexes()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
