"""Per-project compound-label taxonomy (taxonomy v2: GROUPS + saved COMPOUNDS).

This module is the read/write/normalisation layer over a project's `classes_json`
column. It SUPERSEDES the flat per-project label list (`{name,color}`) with a model of
GROUPS + saved COMPOUND labels, while staying 100% back-compatible with the legacy flat
form (transparently upgraded on read — a single-group project then behaves exactly like
today).

MODEL (taxonomy v2):
  * A project defines GROUPS. Each group has {id, name, order, required, members: [...]}.
    A member has {id, name, order} ONLY (members carry NO colour). Members within a group
    are mutually exclusive (a lesion selects at most one member per group).
  * A SAVED COMPOUND label = {id, name, color, selections} where `selections` maps each
    chosen group id -> one of its member ids. A compound is VALID only if it includes a
    member for every REQUIRED group (optional groups may be omitted). Compounds are the
    project's palette of paintable, coloured labels.
  * 'unknown' is a default compound, re-seeded on read (like today's default 'unknown'
    label), and is the default paint label.

A lesion's label references a compound AND stores a denormalised SNAPSHOT of that
compound's {name,color,selections} at assign time (see projects.py), so a later preset
edit/delete never orphans a lesion's meaning. The snapshot is persisted in the
annotation's single `label_snapshot` column (JSON, base64-friendly for future export).
Per-group selections stay queryable because the snapshot stores `{groupId: memberName}`
plus the resolved member ids.

STORAGE SHAPE (the value of `classes_json`):
  The stored value is a JSON object with a `schema` discriminator:

      {
        "schema": "compound-v2",
        "groups":    [ {id,name,order,required,members:[{id,name,order}, ...]}, ... ],
        "compounds": [ {id,name,color,selections:{groupId:memberId}}, ... ]
      }

  For backwards compatibility the OLD forms are still tolerated and upgraded ON READ:
    * legacy string-array  `["lesion","midrib"]`
    * legacy object-array  `[{id,name,color,order}, ...]`
  Both are wrapped into ONE default group named 'Class' whose members are the old labels,
  and each old label is minted as a saved compound (single-group selection) that KEEPS its
  original name + colour. The upgrade is idempotent: re-reading an already-v2 value is a
  no-op. New/empty projects seed a single 'unknown' compound backed by a single default
  group.

The READ surface (`taxonomy_out`) returns BOTH the v2 shape (groups/compounds) AND a flat
`classes` list (the compounds projected to `{id,name,color,order}`) so every existing
call site that reads `project['classes']` / `batch['classes']` keeps working unchanged —
a single-group project looks/behaves exactly like today.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

# Default label for new/empty projects. REMOVABLE like any other — there is no
# forced/undeletable label. Re-seeded on read so the project is never truly label-less.
DEFAULT_LABEL = 'thing'

# Schema discriminator stored in `classes_json` to mark a taxonomy-v2 value. The legacy
# forms (string-array / object-array) have NO discriminator and are detected by shape.
SCHEMA_V2 = 'compound-v2'

# Name of the single default group a legacy flat label set is wrapped into on upgrade.
DEFAULT_GROUP_NAME = 'Class'

# A small, readable default palette cycled when seeding brand-new labels. Distinct enough
# at a glance against both light and dark leaf backgrounds.
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


# ── parse (tolerant of all three stored forms) ────────────────────────────────

def _parse(raw: Any) -> Any:
    """Best-effort parse of a stored/incoming `classes_json` value to a Python object.

    Tolerates None/'', a JSON string, or an already-parsed value. Anything unparseable
    collapses to `[]` (the caller decides whether to seed 'unknown').
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
    return parsed


# ── legacy flat-form helpers (kept for the upgrade path) ──────────────────────

def _one(entry: Any, index: int) -> dict:
    """Normalise a single legacy classes entry (string OR object) to a flat label.

    Returns the canonical flat shape `{id,name,color,order}` — the form a legacy project
    stored before taxonomy v2. Used only by the upgrade path (`_upgrade_legacy`).
    """
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
    return {'id': _uid(), 'name': '', 'color': _default_color(index), 'order': index}


def _normalise_flat(parsed: list) -> list[dict]:
    """Normalise a legacy parsed list to canonical flat objects, dropping empty names."""
    out = [_one(e, i) for i, e in enumerate(parsed)]
    out = [c for c in out if c['name']]
    for i, c in enumerate(out):
        c['order'] = i
    return out


# ── taxonomy v2 normalisation ─────────────────────────────────────────────────

def _normalise_member(m: Any, index: int) -> dict:
    """Normalise a group member to {id,name,order}. Members carry NO colour."""
    if isinstance(m, dict):
        name = str(m.get('name') or '').strip()
        mid = m.get('id')
        if not isinstance(mid, str) or not mid:
            mid = _uid()
        order = m.get('order')
        try:
            order = int(order)
        except (TypeError, ValueError):
            order = index
        return {'id': mid, 'name': name, 'order': order}
    if isinstance(m, str):
        return {'id': _uid(), 'name': m.strip(), 'order': index}
    return {'id': _uid(), 'name': '', 'order': index}


def _normalise_group(g: Any, index: int) -> dict:
    """Normalise a group to {id,name,order,required,members:[{id,name,order}]}."""
    if not isinstance(g, dict):
        return {
            'id': _uid(), 'name': '', 'order': index, 'required': False,
            'members': [],
        }
    gid = g.get('id')
    if not isinstance(gid, str) or not gid:
        gid = _uid()
    name = str(g.get('name') or '').strip()
    order = g.get('order')
    try:
        order = int(order)
    except (TypeError, ValueError):
        order = index
    required = bool(g.get('required'))
    raw_members = g.get('members') if isinstance(g.get('members'), list) else []
    members = [_normalise_member(m, i) for i, m in enumerate(raw_members)]
    members = [m for m in members if m['name']]
    for i, m in enumerate(members):
        m['order'] = i
    return {'id': gid, 'name': name, 'order': order, 'required': required, 'members': members}


def _normalise_compound(c: Any, index: int) -> dict:
    """Normalise a saved compound to {id,name,color,selections}.

    `selections` maps groupId -> memberId. colour is coerced to a usable #rrggbb. The
    caller (`is_compound_valid`) checks required-group coverage; normalisation itself is
    lenient so a stored compound whose group/member was deleted still round-trips (it is
    then filtered out of the paintable palette by `taxonomy_out`).
    """
    if not isinstance(c, dict):
        return {'id': _uid(), 'name': '', 'color': _default_color(index), 'selections': {}}
    cid = c.get('id')
    if not isinstance(cid, str) or not cid:
        cid = _uid()
    name = str(c.get('name') or '').strip()
    color = _hex_color(c.get('color'), index)
    raw_sel = c.get('selections') if isinstance(c.get('selections'), dict) else {}
    selections: dict[str, str] = {}
    for g_id, m_id in raw_sel.items():
        if isinstance(g_id, str) and isinstance(m_id, str):
            selections[g_id] = m_id
    return {'id': cid, 'name': name, 'color': color, 'selections': selections}


def _normalise_v2(obj: dict) -> dict:
    """Normalise an already-v2 dict to {schema,groups,compounds}, dropping empties."""
    raw_groups = obj.get('groups') if isinstance(obj.get('groups'), list) else []
    groups = [_normalise_group(g, i) for i, g in enumerate(raw_groups)]
    groups = [g for g in groups if g['name'] or g['members']]
    for i, g in enumerate(groups):
        g['order'] = i
    raw_compounds = obj.get('compounds') if isinstance(obj.get('compounds'), list) else []
    compounds = [_normalise_compound(c, i) for i, c in enumerate(raw_compounds)]
    # t89: an EMPTY name is now legal — such a compound derives its display label from its
    # member selections. Keep it as long as it carries a name OR at least one selection; a
    # compound with neither is truly empty and dropped (was: drop any empty name).
    compounds = [c for c in compounds if c['name'] or c['selections']]
    return {'schema': SCHEMA_V2, 'groups': groups, 'compounds': compounds}


def _seed_unknown() -> dict:
    """Build the canonical seed for an empty/new project: one default group + the
    'unknown' compound selecting that group's single member."""
    gid = _uid()
    mid = _uid()
    cid = _uid()
    group = {
        'id': gid, 'name': DEFAULT_GROUP_NAME, 'order': 0, 'required': True,
        'members': [{'id': mid, 'name': DEFAULT_LABEL, 'order': 0}],
    }
    compound = {
        'id': cid, 'name': DEFAULT_LABEL, 'color': _default_color(0),
        'selections': {gid: mid},
    }
    return {'schema': SCHEMA_V2, 'groups': [group], 'compounds': [compound]}


def _upgrade_legacy(flat: list[dict]) -> dict:
    """Wrap a legacy flat label list into the v2 shape (ONE default group + a compound
    per old label, each keeping its original name + colour). Idempotent in shape.

    The legacy label's `id` is reused as the member id (stable across re-normalisation);
    a fresh compound id is minted per label. An empty `flat` collapses to the 'unknown'
    seed (a single-group project that behaves exactly like today's default).
    """
    if not flat:
        return _seed_unknown()
    gid = _uid()
    members = [
        {'id': lbl['id'] or _uid(), 'name': lbl['name'], 'order': i}
        for i, lbl in enumerate(flat)
    ]
    group = {
        'id': gid, 'name': DEFAULT_GROUP_NAME, 'order': 0, 'required': True,
        'members': members,
    }
    compounds = [
        {'id': lbl['id'] or _uid(), 'name': lbl['name'], 'color': lbl['color'],
         'selections': {gid: members[i]['id']}}
        for i, lbl in enumerate(flat)
    ]
    return {'schema': SCHEMA_V2, 'groups': [group], 'compounds': compounds}


# ── public read API ───────────────────────────────────────────────────────────

def normalise_taxonomy(raw: Any) -> dict:
    """Parse + upgrade a stored `classes_json` value to the canonical v2 shape.

    Accepts the raw JSON string, an already-parsed value, or None/'' (→ seed 'unknown').
    Always returns a non-empty `{schema, groups, compounds}` dict. Legacy forms
    (string-array, object-array) are upgraded into one default group + per-label
    compounds; an already-v2 value is normalised in place. Idempotent.
    """
    parsed = _parse(raw)
    if isinstance(parsed, dict) and parsed.get('schema') == SCHEMA_V2:
        v2 = _normalise_v2(parsed)
        # A truly-empty v2 (no groups AND no compounds) re-seeds 'unknown' so the project
        # is never label-less — mirrors the legacy read behaviour. A project with groups
        # but no compounds yet (the editor mid-setup) is NOT re-seeded: the groups are
        # real intent, and compounds can be added next.
        if not v2['groups'] and not v2['compounds']:
            return _seed_unknown()
        return v2
    if isinstance(parsed, list):
        flat = _normalise_flat(parsed)
        return _upgrade_legacy(flat)
    # Garbage / unknown shape → seed.
    return _seed_unknown()


def taxonomy_out(raw: Any) -> dict:
    """The full READ surface for a project's taxonomy.

    Returns `{groups, compounds, classes}` where `classes` is the compounds projected to
    the legacy flat shape `{id,name,color,order}` — kept so every existing call site
    reading `project['classes']` / `batch['classes']` keeps working unchanged (a single-
    group project looks/behaves exactly like today). Invalid compounds (missing a
    required group, or referencing a deleted member) are dropped from `compounds` AND
    from `classes` so they never appear in the paint palette, but remain queryable via
    the raw stored value.
    """
    v2 = normalise_taxonomy(raw)
    groups = v2['groups']
    group_by_id = {g['id']: g for g in groups}
    valid_compounds = [c for c in v2['compounds'] if is_compound_valid(c, groups)]
    classes = [
        {'id': c['id'], 'name': compound_label(c, groups), 'color': c['color'], 'order': i}
        for i, c in enumerate(valid_compounds)
    ]
    # `groups` carries member detail; `compounds` is the paintable (valid) palette.
    return {'groups': groups, 'compounds': valid_compounds, 'classes': classes,
            'groupById': group_by_id}


# ── compound validation ───────────────────────────────────────────────────────

def is_compound_valid(compound: dict, groups: list[dict]) -> bool:
    """A compound is valid iff it selects a (still-existing) member for EVERY required
    group, and every selection it does make points at a real member of that group.

    Optional groups may be omitted. A selection for a deleted group/member makes the
    compound invalid (it is filtered out of the paint palette; existing lesions keep
    their snapshot).
    """
    sel = compound.get('selections') or {}
    for g in groups:
        if not g.get('required'):
            continue
        member_id = sel.get(g['id'])
        if not member_id:
            return False
        if not any(m['id'] == member_id for m in g['members']):
            return False
    # Every selection that IS present must point at a real group+member.
    member_ids_by_group = {g['id']: {m['id'] for m in g['members']} for g in groups}
    for g_id, m_id in sel.items():
        if g_id not in member_ids_by_group or m_id not in member_ids_by_group[g_id]:
            return False
    return True


# ── compound display label (custom name, else derived from members) ───────────

def derive_label(compound: dict, groups: list[dict]) -> str:
    """The label DERIVED from a compound's member selections: the selected members' names
    joined in GROUP order (a single-group compound => just that member's name). Used when a
    compound carries no custom name (t89). Members deleted since selection contribute
    nothing (their name is gone)."""
    sel = compound.get('selections') or {}
    parts: list[str] = []
    for g in groups:
        m_id = sel.get(g['id'])
        if not m_id:
            continue
        member = next((m for m in g['members'] if m['id'] == m_id), None)
        if member and member.get('name'):
            parts.append(member['name'])
    return ' / '.join(parts)


def compound_label(compound: dict, groups: list[dict]) -> str:
    """A compound's DISPLAY label: its custom `name` when set, else the label DERIVED live
    from its member selections (t89). The single source of truth for how a compound reads
    in the paint palette, a lesion snapshot, and name-based resolution — so a member rename
    flows through everywhere for an uncustomised (empty-name) compound."""
    name = (compound.get('name') or '').strip()
    return name if name else derive_label(compound, groups)


# ── compound snapshot (the denormalised lesion label) ─────────────────────────

def compound_snapshot(compound: dict, groups: list[dict]) -> dict:
    """Build the denormalised snapshot stored on a lesion at assign time.

    `{name, color, selections}` where `selections` maps groupId -> {memberId, memberName,
    groupName} so a later preset edit/delete never orphans a lesion's meaning AND the
    per-group selections stay queryable for analysis. Resolves member/group NAMES at
    snapshot time; if a referenced group/member has since been deleted, the snapshot
    keeps the id with name '' (lesion text + colour never vanish).
    """
    sel = compound.get('selections') or {}
    group_by_id = {g['id']: g for g in groups}
    out_sel: dict[str, dict] = {}
    for g_id, m_id in sel.items():
        g = group_by_id.get(g_id)
        member = next((m for m in g['members'] if m['id'] == m_id), None) if g else None
        out_sel[g_id] = {
            'memberId': m_id,
            'memberName': member['name'] if member else '',
            'groupName': g['name'] if g else '',
        }
    return {
        'name': compound_label(compound, groups),
        'color': _hex_color(compound.get('color'), 0),
        'selections': out_sel,
    }


def snapshot_from_label(raw_taxonomy: Any, label: str | None) -> dict | None:
    """Resolve a paint `label` (a compound NAME) against the project's taxonomy to its
    denormalised snapshot, or None when the name matches no compound.

    Used by create_annotation to snapshot a lesion's label at assign time. The label is
    matched by compound name (the FE sends the compound's name as `label`). A label that
    matches no compound (lenient backend / legacy free-text) yields None — the lesion
    keeps its bare `label` text and a null snapshot, so existing data still renders.
    """
    if not label:
        return None
    v2 = normalise_taxonomy(raw_taxonomy)
    match = next((c for c in v2['compounds'] if compound_label(c, v2['groups']) == label), None)
    if not match:
        return None
    return compound_snapshot(match, v2['groups'])


def id_from_label(raw_taxonomy: Any, label: str | None) -> str | None:
    """Resolve a paint `label` (a compound NAME) against the project's taxonomy to the
    matching compound's stable `id`, or None when the name matches no compound.

    Sibling of `snapshot_from_label` — t64 (annotations reference a compound by id):
    `do_create_annotation` stores this id on the annotation (`compound_id`) so display
    can resolve {name,color,selections} LIVE from the CURRENT taxonomy instead of a
    frozen snapshot (rename/recolour then flows through to every lesion painted with
    that compound).
    """
    if not label:
        return None
    v2 = normalise_taxonomy(raw_taxonomy)
    match = next((c for c in v2['compounds'] if compound_label(c, v2['groups']) == label), None)
    return match['id'] if match else None


def compounds_by_id(raw_taxonomy: Any) -> dict[str, dict]:
    """The CURRENT taxonomy's compounds keyed by id — the live-resolution lookup table
    for `{name,color,selections}` by `compound_id` (t64). Uses the full (not just
    paint-valid) compound list so a compound that's since become invalid (e.g. a
    required group's member deleted) still resolves a NAME/COLOR for lesions that
    reference it (only the paint palette hides invalid compounds, not display)."""
    v2 = normalise_taxonomy(raw_taxonomy)
    return {c['id']: c for c in v2['compounds']}


def resolve_compound_snapshot(raw_taxonomy: Any, compound_id: str | None) -> dict | None:
    """LIVE display resolution for a lesion's `compound_id` (t64, C2): `{name, color,
    selections}` from the CURRENT taxonomy, or None when `compound_id` is null or no
    longer resolves (the deleted-with-no-reassignment case never reaches display —
    `update_project` blocks it — so a miss here means legacy/pre-migration data;
    callers fall back to the frozen `label_snapshot`)."""
    if not compound_id:
        return None
    v2 = normalise_taxonomy(raw_taxonomy)
    match = next((c for c in v2['compounds'] if c['id'] == compound_id), None)
    if not match:
        return None
    return compound_snapshot(match, v2['groups'])


def dump_taxonomy(taxonomy: Any) -> str:
    """Serialise a taxonomy value for storage in `classes_json`.

    Accepts either a v2 dict (re-normalised) or a legacy list (upgraded). Always emits
    the v2 object form so the next read is a clean no-op — EXCEPT an explicitly-empty
    legacy list (`[]`), which is stored verbatim as `'[]'` so the legacy "delete every
    label" contract is preserved (the next READ re-seeds 'unknown'; the project is never
    truly label-less). This mirrors the original `dump_classes([])` → `'[]'` behaviour.
    """
    if isinstance(taxonomy, list):
        flat = _normalise_flat(taxonomy)
        if not flat:
            return '[]'
        return json.dumps(_upgrade_legacy(flat))
    if isinstance(taxonomy, dict):
        if taxonomy.get('schema') == SCHEMA_V2:
            v2 = _normalise_v2(taxonomy)
        else:
            v2 = _upgrade_legacy(_normalise_flat(taxonomy.get('classes', [])
                                                 if 'classes' in taxonomy else []))
        return json.dumps(v2)
    return json.dumps(_seed_unknown())


def coerce_taxonomy(payload: Any, existing: Any = None) -> dict:
    """Normalise an incoming taxonomy body value for STORAGE (the editor payload).

    The editor sends the canonical v2 object (`{groups, compounds}`). Coerce defensively
    so a legacy list body still upgrades cleanly. Returns the v2 dict (NOT a string);
    `dump_taxonomy` serialises it. An explicitly-empty legacy write (`[]`) is stored as
    `'[]'` by `dump_taxonomy` and re-seeds 'unknown' on the next READ — mirroring the
    legacy `coerce_classes` contract that a write may record "no labels" while reads stay
    non-empty.

    `existing` (t64, C3): the project's CURRENT stored taxonomy value (raw, pre-coerce),
    when supplied. A compound whose id is ALREADY present there keeps its STORED
    `selections` — an incoming change to an existing id's selections is silently NOT
    applied (name/colour ARE). A compound composition is immutable once saved; changing
    it means minting a new compound id. New ids (not in `existing`) may set any
    selections.

    The lock applies only to a genuine v2 (`{groups, compounds}`) payload — the EDITOR's
    shape, where group/member ids are the caller's own stable ids. A legacy flat `classes`
    LIST re-upgrades through `_upgrade_legacy` on every write, which (by design) mints a
    FRESH default-group id each time; locking a compound's selections to a stored group id
    that no longer exists in the freshly-minted group would falsely invalidate it. Nothing
    is lost: a flat-list body has exactly one group/one member per compound, so there is no
    meaningful "composition" for immutability to protect.
    """
    v2 = _coerce_taxonomy_raw(payload)
    if existing is not None and isinstance(payload, dict):
        existing_by_id = {c['id']: c for c in normalise_taxonomy(existing)['compounds']}
        for c in v2['compounds']:
            locked = existing_by_id.get(c['id'])
            if locked is not None:
                c['selections'] = dict(locked.get('selections') or {})
    return v2


def _coerce_taxonomy_raw(payload: Any) -> dict:
    """The shape-coercion half of `coerce_taxonomy`, split out so immutability
    enforcement (which needs the `existing` taxonomy) wraps it rather than duplicates it."""
    if isinstance(payload, list):
        flat = _normalise_flat(payload)
        if not flat:
            # Explicitly-empty flat write: store an empty v2 (no compounds). The next READ
            # re-seeds 'unknown' (see normalise_taxonomy) so the project is never label-less,
            # mirroring the legacy 'delete every label' contract.
            return {'schema': SCHEMA_V2, 'groups': [], 'compounds': []}
        return _upgrade_legacy(flat)
    if isinstance(payload, dict) and payload.get('schema') == SCHEMA_V2:
        return _normalise_v2(payload)
    if isinstance(payload, dict) and ('groups' in payload or 'compounds' in payload):
        # Editor payload without an explicit schema tag — treat as v2.
        return _normalise_v2({**payload, 'schema': SCHEMA_V2})
    return _seed_unknown()


# ── legacy flat compatibility shims ───────────────────────────────────────────
#
# The original public functions (`normalise_classes`, `coerce_classes`, `dump_classes`,
# `classes_from_row`) are kept as thin adapters over the v2 layer so any stray legacy
# caller keeps working. New code should use the v2 functions above.

def normalise_classes(raw: Any) -> list[dict]:
    """Legacy flat-form read: project the v2 taxonomy to `{id,name,color,order}`."""
    return taxonomy_out(raw)['classes']


def coerce_classes(payload: Any) -> list[dict]:
    """Legacy flat-form coerce: upgrade then project to the flat list."""
    return taxonomy_out(dump_taxonomy(payload))['classes']


def dump_classes(classes: Any) -> str:
    """Legacy flat-form dump: serialise a flat list (or v2 dict) to classes_json."""
    return dump_taxonomy(classes)


def classes_from_row(row: dict | None) -> list[dict]:
    """Legacy: read `classes_json` off a project row → flat object list."""
    raw = row.get('classes_json') if row else None
    return normalise_classes(raw)
