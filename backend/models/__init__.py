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
    create_all() only creates brand-new tables — it never alters existing
    ones. Hand-picking which columns to migrate (the old approach here)
    silently rots: every column added to a model after someone's database
    already exists needs its own explicit ALTER, and it's easy to add one
    and forget the migration line — which is exactly what happened
    (Project.folder/city and Floor.plan_image_url were never added here,
    so anyone whose database predates those columns gets "Invalid column
    name" the moment a query touches them).

    This instead walks every mapped model/table and adds whatever columns
    exist in the model but not yet in the live database — self-healing
    for *any* column added later, not just the ones we remembered to list.
    Always adds as NULL-able regardless of the model's own nullable
    setting, since existing rows have no value for a brand-new column and
    MSSQL can't add a NOT NULL column to a non-empty table without one.
    Doesn't add foreign-key constraints on the new column (none of the
    columns this has needed to add so far require one) — a column that
    both post-dates its table AND needs an FK would still need a manual
    migration line.
    """
    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())
    for mapper in Base.registry.mappers:
        table = mapper.local_table
        if table is None or table.name not in existing_tables:
            continue  # brand-new table — create_all() already handled it
        existing_cols = {c["name"] for c in inspector.get_columns(table.name)}
        for column in table.columns:
            if column.name in existing_cols:
                continue
            col_type = column.type.compile(dialect=engine.dialect)
            with engine.begin() as conn:
                conn.execute(text(f"ALTER TABLE {table.name} ADD {column.name} {col_type} NULL"))


def _ensure_indexes():
    """Guarantees the filtered unique index on spots.client_spot_id exists.
    Postgres-compatible: uses SQLAlchemy's inspector to check for the index
    instead of MSSQL's sys.indexes system table."""
    inspector = inspect(engine)
    if "spots" not in inspector.get_table_names():
        return
    existing_index_names = {idx["name"] for idx in inspector.get_indexes("spots")}
    if "ix_spots_client_spot_id" in existing_index_names:
        return
    with engine.begin() as conn:
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
