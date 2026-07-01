"""
Shared image helpers: on-disk store, content hashing, cached PIL loads, crop/overview PNGs.

Extracted so the projects/annotator blueprint can serve image tiles without importing
app.py (which would be circular). app.py still has its own copies for the legacy tools;
folding those into this module is a low-risk future cleanup (noted in ANNOTATOR_STATUS.md).
"""

from __future__ import annotations

import hashlib
import io
from pathlib import Path

from PIL import Image

from . import db as _db

_img_cache: dict[str, Image.Image] = {}


def _img_dir() -> Path:
    """Resolved lazily (NOT at import time) from the active AppConfig."""
    return _db.get_config().data_dir / 'images'


def hash_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:24]


def store_image(data: bytes, ext: str) -> str:
    """Write image bytes into the content-addressed store; return the hash. Idempotent."""
    h = hash_bytes(data)
    img_dir = _img_dir()
    img_dir.mkdir(parents=True, exist_ok=True)
    dst = img_dir / f'{h}.{ext}'
    if not dst.exists():
        dst.write_bytes(data)
    _img_cache.pop(f'{h}.{ext}', None)
    return h


def get_image(image_hash: str, image_ext: str) -> Image.Image:
    key = f'{image_hash}.{image_ext}'
    if key not in _img_cache:
        _img_cache[key] = Image.open(_img_dir() / key)
    return _img_cache[key]


def overview_png(img: Image.Image, max_side: int = 2000) -> bytes:
    """Downscaled whole-image PNG (context view); long side clamped to max_side."""
    w, h = img.size
    if max(w, h) > max_side:
        scale = max_side / max(w, h)
        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    buf = io.BytesIO()
    img.convert('RGB').save(buf, 'PNG')
    return buf.getvalue()


def crop_png(img: Image.Image, x: int, y: int, w: int, h: int) -> bytes:
    """Full-resolution crop PNG (tile / detail view), clipped to image bounds."""
    iw, ih = img.size
    x, y = max(0, x), max(0, y)
    buf = io.BytesIO()
    img.crop((x, y, min(iw, x + w), min(ih, y + h))).convert('RGB').save(buf, 'PNG')
    return buf.getvalue()
