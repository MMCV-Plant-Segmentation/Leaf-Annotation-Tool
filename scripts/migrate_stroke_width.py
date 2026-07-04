#!/usr/bin/env python3
"""One-off data backfill: give the old placeholder-brush annotations a real stroke_width.

The pre-Phase-1 annotations (all Burcu's early practice strokes) have stroke_width IS NULL,
so the server floors them to ~1px hairlines. Setting a small width makes the server render
them via its centerline-buffer fallback along the stored points_json path (raw mouse points
are preserved) — i.e. a thin brush traced along her original path.

DRY-RUN by default — shows what WOULD change. Pass --apply to write. Reversible: the value
is just a column; a backup + `SET stroke_width=NULL WHERE stroke_width=<width>` undoes it.

TESTENV (native DB file) — validate here FIRST:
  uv run python3 scripts/migrate_stroke_width.py --db ~/.local/share/leaf-annotation-test/app.db
  uv run python3 scripts/migrate_stroke_width.py --db ~/.local/share/leaf-annotation-test/app.db --apply

PROD (Docker; the image has no sqlite3 CLI, so run via the container Python) — only after
a fresh backup + after verifying in testenv:
  docker cp scripts/migrate_stroke_width.py leaf-annotation-tool-app-1:/tmp/m.py
  docker exec leaf-annotation-tool-app-1 python3 /tmp/m.py --db /data/app.db            # dry-run
  docker exec leaf-annotation-tool-app-1 python3 /tmp/m.py --db /data/app.db --apply     # apply
"""
import argparse
import json
import sqlite3
import sys
from pathlib import Path


def _recompute_tiles(con, ann_ids) -> int:
    """Re-derive annotation_tile membership for these rows using the BACKEND's OWN geometry+tiling
    function, so we follow the exact path a real request would. Widening a stroke can make its
    buffered area newly clip an adjacent tile; a bare column UPDATE leaves annotation_tile stale, so
    we mirror update_annotation's recompute (webapp/projects.py). Fails loudly if the import breaks."""
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from webapp.projects import _tiles_intersecting  # import here so a dry-run needs no BE deps

    changed = 0
    for aid in ann_ids:
        r = con.execute(
            'SELECT project_image_id, kind, points_json, stroke_width, outline_json '
            'FROM annotation WHERE id = ?', (aid,)).fetchone()
        if r is None:
            continue
        outline = json.loads(r['outline_json']) if r['outline_json'] else None
        new_tiles = _tiles_intersecting(
            con, r['project_image_id'], r['kind'], json.loads(r['points_json']),
            r['stroke_width'], outline=outline)
        old_tiles = {row['tile_id'] for row in con.execute(
            'SELECT tile_id FROM annotation_tile WHERE annotation_id = ?', (aid,)).fetchall()}
        if set(new_tiles) == old_tiles:
            continue
        con.execute('DELETE FROM annotation_tile WHERE annotation_id = ?', (aid,))
        for tid in new_tiles:
            con.execute('INSERT OR IGNORE INTO annotation_tile (annotation_id, tile_id) VALUES (?, ?)',
                        (aid, tid))
        changed += 1
    return changed


def main() -> int:
    ap = argparse.ArgumentParser(description='Backfill stroke_width on old NULL-width annotations.')
    ap.add_argument('--db', required=True, help='Path to app.db (testenv file, or /data/app.db in prod).')
    ap.add_argument('--width', type=float, default=4.0, help='Width to set (default 4.0 — thin).')
    ap.add_argument('--apply', action='store_true', help='Actually write (default: dry-run).')
    args = ap.parse_args()

    con = sqlite3.connect(args.db)
    con.row_factory = sqlite3.Row
    total = con.execute('SELECT COUNT(*) FROM annotation WHERE stroke_width IS NULL').fetchone()[0]
    by = con.execute(
        "SELECT annotator, COUNT(*) n FROM annotation WHERE stroke_width IS NULL GROUP BY annotator ORDER BY n DESC"
    ).fetchall()

    print(f'DB: {args.db}')
    print(f'annotations with stroke_width IS NULL: {total}')
    for r in by:
        print(f'  {r["annotator"]}: {r["n"]}')
    if total == 0:
        print('nothing to migrate.')
        return 0

    if not args.apply:
        print(f'\nDRY-RUN — would set stroke_width={args.width} on {total} rows, then recompute their '
              'tile membership via the backend\'s webapp.projects._tiles_intersecting. '
              'Re-run with --apply to write.')
        return 0

    ids = [r['id'] for r in con.execute(
        'SELECT id FROM annotation WHERE stroke_width IS NULL').fetchall()]
    with con:
        con.execute('UPDATE annotation SET stroke_width=? WHERE stroke_width IS NULL', (args.width,))
        retiled = _recompute_tiles(con, ids)
    left = con.execute('SELECT COUNT(*) FROM annotation WHERE stroke_width IS NULL').fetchone()[0]
    print(f'\nAPPLIED: set stroke_width={args.width} on {len(ids)} rows; recomputed tile membership '
          f'on {retiled} of them (via the BE path). Remaining NULL: {left}.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
