"""Per-project label taxonomy — the value-format layer over `project.classes_json`.

Decision (Christian, Option A): each project owns a FLAT list of labels. There is no
cross-project sharing and no hierarchy — those stay in the backlog. Each label is an
OBJECT, not a bare string:

    { "id": "<stable uuid>", "name": "lesion", "color": "#2563eb", "order": 0 }

`annotation.label` stays a free-text string (unchanged) and the backend stays LENIENT:
an annotation whose label is not in the configured set is never rejected. This module is
purely the read/write/normalisation layer over the `classes_json` column.

Back-compat / migration (no schema change — `classes_json` is an existing TEXT column):
the OLD form stored a JSON string-array (`["lesion","midrib","uncertain"]`) or `'[]'`.
We tolerate and upgrade that on read:

  * old string-array → [{name: <str>, color: <default>, order: <index>, id: <new>}]
  * `'[]'` / missing / new project → seed the single removable label "unknown"
  * new object-array → normalised in place (ids/colors/order filled where absent)

The upgrade is performed lazily on read (`normalise_classes`) and persisted back on the
next write, so existing data keeps working without a one-time migration pass. New
projects are seeded explicitly in `create_project`.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

# Default label for new/empty projects. REMOVABLE like any other — there is no
# forced/undeletable label anymore (the old hardcoded ['lesion','midrib','uncertain']
# FE fallback is gone).
UNKNOWN_LABEL = 'unknown'

# A small, readable default palette cycled when upgrading the legacy string-array form
# (which carried no colour) and when seeding brand-new labels. Distinct enough at a
# glance against both light and dark leaf backgrounds.
DEFAULT_PALETTE = [
    '#2563eb',  # blue
    '#dc2626',  # red
    '#16a34a',  # green
    '#d97706',  # amber
    '#7c3aed',  # violet
    '#0891b2',  # cyan
    '#db2777',  # pink
    '#65a30d',  # lime
]


def _uid() -> str:
    return str(uuid.uuid4())


def _default_color(index: int) -> str:
    return DEFAULT_PALETTE[index % len(DEFAULT_PALETTE)]


def _hex_color(value: Any, index: int) -> str:
    """Coerce `value` to a usable `#rrggbb` colour, falling back to the palette.

    Tolerant: legacy/upgraded rows may carry no colour at all; a stray bad string is
    replaced rather than allowed to break canvas rendering.
    """
    if isinstance(value, str):
        v = value.strip()
        if v.startswith('#') and len(v) in (4, 7):
            try:
                int(v[1:], 16)
                return v.lower()
            except ValueError:
                pass
    return _default_color(index)


def _one(entry: Any, index: int) -> dict:
    """Normalise a single classes entry (string OR object) to the canonical shape."""
    if isinstance(entry, str):
        name = entry.strip()
        return {'id': _uid(), 'name': name, 'color': _default_color(index), 'order': index}
    if isinstance(entry, dict):
        name = str(entry.get('name') or '').strip()
        cid = entry.get('id')
        if not isinstance(cid, str) or not cid:
            cid = _uid()
        color = _hex_color(entry.get('color'), index)
        order = entry.get('order')
        try:
            order = int(order)
        except (TypeError, ValueError):
            order = index
        return {'id': cid, 'name': name, 'color': color, 'order': order}
    # Garbage entry — skip-detectable empty placeholder (filtered by normalise_classes).
    return {'id': _uid(), 'name': '', 'color': _default_color(index), 'order': index}


def _parse(raw: Any) -> Any:
    """Best-effort parse of a stored/incoming `classes_json` value to a Python list.

    Tolerates None/'', a JSON string, or an already-parsed list. Anything unparseable
    or non-list collapses to `[]` (the caller decides whether to seed 'unknown').
    """
    if raw is None or raw == '':
        return []
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except (ValueError, TypeError):
            return []
    else:
        parsed = raw
    return parsed if isinstance(parsed, list) else []


def _normalise_list(parsed: list) -> list[dict]:
    """Normalise a parsed list of entries to canonical objects, dropping empty names."""
    out = [_one(e, i) for i, e in enumerate(parsed)]
    out = [c for c in out if c['name']]
    # Re-stamp order to be contiguous after any drop, preserving the input order.
    for i, c in enumerate(out):
        c['order'] = i
    return out


def normalise_classes(raw: Any) -> list[dict]:
    """Parse + upgrade a stored `classes_json` value to the canonical object list.

    Accepts the raw JSON string, an already-parsed list, or None/'' (→ seed 'unknown').
    Always returns a non-empty list of `{id, name, color, order}` objects (empty-name
    rows dropped; if that leaves nothing, the 'unknown' seed is returned). This is the
    READ path: a stored `'[]'`/missing value is surfaced as a single `unknown` label.
    """
    out = _normalise_list(_parse(raw))
    if not out:
        out = [{'id': _uid(), 'name': UNKNOWN_LABEL, 'color': _default_color(0), 'order': 0}]
    return out


def classes_from_row(row: dict | None) -> list[dict]:
    """Read `classes_json` off a project row (or None) → canonical object list."""
    raw = row.get('classes_json') if row else None
    return normalise_classes(raw)


def coerce_classes(payload: Any) -> list[dict]:
    """Normalise an incoming `classes` body value for STORAGE.

    The editor sends the canonical object list, but coerce defensively so a legacy
    string-array body (or a mix) still upgrades cleanly. Empty list is allowed — the
    editor may legitimately delete every label; we DO NOT re-seed 'unknown' here (the
    FE decides), but `normalise_classes` re-seeds on read so the project is never truly
    label-less. An explicitly-empty (or all-empty-name) write therefore returns `[]`,
    which `dump_classes` stores as `'[]'` and the next read re-seeds to `unknown`.

    Distinct from `normalise_classes` precisely so a write can record "no labels"
    while reads stay non-empty.
    """
    return _normalise_list(_parse(payload))


def dump_classes(classes: list[dict]) -> str:
    """Serialise the canonical object list for storage in `classes_json`."""
    return json.dumps(classes or [])
