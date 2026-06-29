"""One-shot maintenance: re-derive the stored leaf bbox + origin_y for images that
predate the largest-connected-component bbox rule.

Such images have a stored leaf bbox spanning nearly the whole frame (the old
all-above-threshold span), which collapses grid centring to origin 0 and leaves the
top tile row almost entirely background. The tiling *preview* already sidesteps this
(it recomputes the bbox live), but **batch generation** reads the stored columns — so
fix the stored data here. Idempotent: re-running yields the same values.

Skips any image already tiled into a batch — re-deriving its origin would shift the
grid out from under the tiles that were already created from the old geometry.

Run once after deploying the bbox fix (uses HT_DATA_DIR like the app):
    uv run python webapp/rederive_bboxes.py
"""
from __future__ import annotations

from webapp import db, imaging, tiling


def rederive(con) -> tuple[int, int]:
    """Recompute leaf_*/origin_y for every un-tiled image. Returns (updated, skipped)."""
    tiled = {r['project_image_id'] for r in
             con.execute('SELECT DISTINCT project_image_id FROM tile').fetchall()}
    rows = con.execute(
        '''SELECT pi.*, p.black_threshold AS thr, p.tile_size_px AS ts
             FROM project_image pi JOIN project p ON p.id = pi.project_id'''
    ).fetchall()
    updated = skipped = 0
    for r in rows:
        if r['id'] in tiled:
            skipped += 1
            continue
        img = imaging.get_image(r['image_hash'], r['image_ext'])
        bb = tiling.compute_leaf_bbox(img, r['thr']) or tiling.Rect(0, 0, r['width'], r['height'])
        oy = tiling.bbox_centered_origin_y(bb, r['height'], r['ts'])
        if (r['leaf_x'], r['leaf_y'], r['leaf_w'], r['leaf_h'], r['origin_y']) == (bb.x, bb.y, bb.w, bb.h, oy):
            continue  # already correct — leave it (keeps the run idempotent / write-free)
        con.execute(
            'UPDATE project_image SET leaf_x=?, leaf_y=?, leaf_w=?, leaf_h=?, origin_y=? WHERE id=?',
            (bb.x, bb.y, bb.w, bb.h, oy, r['id']),
        )
        updated += 1
    con.commit()
    return updated, skipped


def main() -> None:
    con = db.get_db()
    try:
        updated, skipped = rederive(con)
        print(f're-derived {updated} image(s); skipped {skipped} already-tiled')
    finally:
        db.close_db(con)


if __name__ == '__main__':
    main()
