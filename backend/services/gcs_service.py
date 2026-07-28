"""
GCS service — upload site media and return public URL.
Falls back to local /uploads/ folder when GCS creds not configured (POC mode).
"""
import os
import uuid
import aiofiles
from pathlib import Path
from typing import Tuple
from config import settings

LOCAL_UPLOAD_DIR = Path("./uploads")
LOCAL_UPLOAD_DIR.mkdir(exist_ok=True)

_gcs_client = None
_bucket = None


def _get_bucket():
    global _gcs_client, _bucket
    if _bucket:
        return _bucket
    try:
        from google.cloud import storage as gcs
        _gcs_client = gcs.Client(project=settings.GCS_PROJECT_ID)
        _bucket = _gcs_client.bucket(settings.GCS_BUCKET_NAME)
        return _bucket
    except Exception:
        return None


async def upload_media(
    file_bytes: bytes,
    original_filename: str,
    project_id: str,
    room_id: str,
) -> Tuple[str, str]:
    """
    Upload media file.
    Returns (public_url, gcs_path).
    Falls back to local storage if GCS not configured.
    """
    ext = Path(original_filename).suffix.lower()
    unique_name = f"{uuid.uuid4().hex}{ext}"
    gcs_path = f"projects/{project_id}/rooms/{room_id}/{unique_name}"

    bucket = _get_bucket()

    if bucket and settings.GCS_PROJECT_ID:
        blob = bucket.blob(gcs_path)
        blob.upload_from_string(file_bytes, content_type=_guess_mime(ext))
        blob.make_public()
        public_url = blob.public_url
    else:
        # Local fallback for POC
        local_path = LOCAL_UPLOAD_DIR / unique_name
        async with aiofiles.open(local_path, "wb") as f:
            await f.write(file_bytes)
        public_url = f"/uploads/{unique_name}"
        gcs_path = str(local_path)

    return public_url, gcs_path


def _guess_mime(ext: str) -> str:
    mapping = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".mp4": "video/mp4",
        ".mov": "video/quicktime",
        ".webp": "image/webp",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }
    return mapping.get(ext, "application/octet-stream")


async def download_media(gcs_path: str) -> bytes:
    """Read back bytes previously stored via upload_media() — needed for in-place
    edits (e.g. syncing the Activity Excel) where we must load-modify-save the
    same file rather than starting from a fresh template."""
    bucket = _get_bucket()
    if bucket and settings.GCS_PROJECT_ID:
        blob = bucket.blob(gcs_path)
        return blob.download_as_bytes()
    async with aiofiles.open(gcs_path, "rb") as f:
        return await f.read()


async def upload_bytes_to_path(file_bytes: bytes, gcs_path: str, content_type: str) -> str:
    """Overwrite the file at an already-known path/blob (used to sync the
    Activity Excel back in place after AI analysis updates progress cells)."""
    bucket = _get_bucket()
    if bucket and settings.GCS_PROJECT_ID:
        blob = bucket.blob(gcs_path)
        blob.upload_from_string(file_bytes, content_type=content_type)
        blob.make_public()
        return blob.public_url
    async with aiofiles.open(gcs_path, "wb") as f:
        await f.write(file_bytes)
    return f"/uploads/{Path(gcs_path).name}"


async def delete_media(gcs_path: str):
    bucket = _get_bucket()
    if bucket:
        blob = bucket.blob(gcs_path)
        blob.delete()
    else:
        try:
            Path(gcs_path).unlink(missing_ok=True)
        except Exception:
            pass
