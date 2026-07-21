"""Backend acceptance for t89 — a compound with an EMPTY name derives its display label
LIVE from its member selections, so renaming a member flows through to the paint palette,
the snapshot, and name-based resolution. A NON-EMPTY name stays a verbatim custom label.

Design (Christian 2026-07-21): make `compound.name` empty-allowed. Empty => derive the
label by joining the selected member names in GROUP order (single-group default => just
the member name). Custom name => used as-is. The default seed keeps its name 'thing'
(stays custom unless the user clears it), so this only adds the empty=>derive path.

Pure-function style (no HTTP): exercises webapp.taxonomy directly. PASS lines + bare
asserts; exits non-zero on first failure.

Run with: uv run python webapp/tests/test_compound_derived_label.py
"""

import os
import tempfile

os.environ.setdefault('HT_DATA_DIR', tempfile.mkdtemp(prefix='leaf-anno-derived-'))
os.environ.setdefault('SECRET_KEY', 'test-secret')

from webapp import taxonomy


def _tax(*, thing_name='thing', size_name='large', compound_name='', selections=None,
         with_size=False):
    """Build a v2 taxonomy: a required 'Class' group (member `thing_name`), optionally an
    optional 'Size' group (member `size_name`), and one compound."""
    groups = [{
        'id': 'g-class', 'name': 'Class', 'order': 0, 'required': True,
        'members': [{'id': 'm-thing', 'name': thing_name, 'order': 0}],
    }]
    if with_size:
        groups.append({
            'id': 'g-size', 'name': 'Size', 'order': 1, 'required': False,
            'members': [{'id': 'm-large', 'name': size_name, 'order': 0}],
        })
    sel = selections if selections is not None else {'g-class': 'm-thing'}
    compound = {'id': 'c1', 'name': compound_name, 'color': '#2563eb', 'selections': sel}
    return {'schema': taxonomy.SCHEMA_V2, 'groups': groups, 'compounds': [compound]}


def run():
    groups_single = _tax()['groups']
    empty = {'id': 'c1', 'name': '', 'color': '#2563eb', 'selections': {'g-class': 'm-thing'}}
    custom = {'id': 'c1', 'name': 'My Label', 'color': '#2563eb', 'selections': {'g-class': 'm-thing'}}

    # D1 — compound_label: empty name derives the single member's name; custom is verbatim.
    assert taxonomy.compound_label(empty, groups_single) == 'thing', 'D1a derive single'
    assert taxonomy.compound_label(custom, groups_single) == 'My Label', 'D1b custom verbatim'
    print('PASS D1 compound_label empty=>derive, custom=>verbatim')

    # D2 — multi-group empty name joins member names in GROUP order.
    tax2 = _tax(with_size=True, selections={'g-class': 'm-thing', 'g-size': 'm-large'})
    assert taxonomy.compound_label(tax2['compounds'][0], tax2['groups']) == 'thing / large', 'D2 join'
    print('PASS D2 multi-group derive joins in group order')

    # D3 — taxonomy_out projects the DERIVED label into the flat `classes` palette, and a
    # member rename flows through to it (the core t89 symptom).
    out = taxonomy.taxonomy_out(_tax(compound_name=''))
    assert [c['name'] for c in out['classes']] == ['thing'], f"D3a {out['classes']}"
    out2 = taxonomy.taxonomy_out(_tax(compound_name='', thing_name='nothing'))
    assert [c['name'] for c in out2['classes']] == ['nothing'], f"D3b {out2['classes']}"
    print('PASS D3 classes palette derives + tracks member rename')

    # D4 — an empty-name compound WITH valid selections survives normalisation (not dropped);
    # an empty-name compound with NO selections is dropped as truly empty.
    kept = taxonomy.normalise_taxonomy(_tax(compound_name=''))
    assert [c['id'] for c in kept['compounds']] == ['c1'], f"D4a kept {kept['compounds']}"
    dropped = taxonomy.normalise_taxonomy(
        {'schema': taxonomy.SCHEMA_V2, 'groups': _tax()['groups'],
         'compounds': [{'id': 'c1', 'name': '', 'color': '#111111', 'selections': {}}]})
    assert dropped['compounds'] == [], f"D4b dropped {dropped['compounds']}"
    print('PASS D4 empty-name+selections kept; empty-name+no-selections dropped')

    # D5 — the lesion snapshot's `name` is the DERIVED label for an empty-name compound.
    snap = taxonomy.compound_snapshot(empty, groups_single)
    assert snap['name'] == 'thing', f"D5 snapshot name {snap['name']}"
    print('PASS D5 snapshot name uses derived label')

    # D6 — name-based resolution (the FE sends the derived label as the paint `label`)
    # resolves an empty-name compound by its DERIVED name to id + snapshot.
    raw = _tax(compound_name='')
    assert taxonomy.id_from_label(raw, 'thing') == 'c1', 'D6a id_from_label derived'
    assert taxonomy.snapshot_from_label(raw, 'thing')['name'] == 'thing', 'D6b snapshot_from_label derived'
    assert taxonomy.id_from_label(raw, 'nope') is None, 'D6c no match'
    print('PASS D6 name-based resolution matches the derived label')

    print('ALL PASS test_compound_derived_label')


if __name__ == '__main__':
    run()
