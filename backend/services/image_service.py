"""Server-side image inspection shared by both upload paths (the web dev/fast
Upload page and the mobile app's photo endpoint)."""
import io
from PIL import Image

# A full 360 equirectangular photo is exactly 2:1 (width = 2 x height) by the
# format's own definition — a Ricoh THETA X's stitched still is 11008x5504,
# for instance. A flat photo (phone camera, or the fisheye/hemisphere camera
# briefly evaluated for this project) is never this shape. Allow a small
# tolerance for JPEG re-encodes / thumbnailing that can round a dimension by
# a pixel or two without the image having actually changed shape.
EQUIRECT_RATIO = 2.0
EQUIRECT_TOLERANCE = 0.04


def detect_media_type(image_bytes: bytes, mime: str) -> str:
    """'360' for a real equirectangular photo, else 'photo'/'video' by mime.

    This used to be guessed from *which upload flow or room a photo was
    attached to* (see PanoramaViewer.jsx's old isFlatPhoto heuristic) — that
    was only ever true by coincidence: mobile happened to only have a flat
    phone camera when it was written. Now that mobile also captures true
    360 photos (Ricoh THETA X, on-device stitched) into the exact same kind
    of Spot, the room a photo lives under no longer implies its shape, so
    detection has to look at the actual pixels instead.
    """
    if "video" in mime:
        return "video"
    if "image" not in mime:
        return "photo"
    try:
        with Image.open(io.BytesIO(image_bytes)) as img:
            width, height = img.size
    except Exception:
        return "photo"  # unreadable/corrupt — let the existing photo path handle it
    if height <= 0:
        return "photo"
    ratio = width / height
    if abs(ratio - EQUIRECT_RATIO) <= EQUIRECT_RATIO * EQUIRECT_TOLERANCE:
        return "360"
    return "photo"
