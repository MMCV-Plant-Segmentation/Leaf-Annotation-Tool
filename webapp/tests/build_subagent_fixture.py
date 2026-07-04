"""Build the SUBAGENT TEST FIXTURE — a small, synthetic, in-repo dataset that is a DISJOINT
data lineage from prod BY CONSTRUCTION.

Security invariant (see docs): a subagent's test env must NEVER be sourced from prod's live
volume OR prod's backups — not even read-only. This fixture is that separate source. It is
generated here from nothing but synthetic content (a couple of procedurally-drawn PNGs), so
there is no code path by which prod data can leak into it.

Output (committed): webapp/tests/fixtures/subagent_dataset/
    app.db            — the app's real schema (built via create_app) + synthetic rows:
                        the seeded 'admin' user, one demo annotator, one demo project, and
                        the two imported images below.
    images/, jsons/   — content-addressed store the app's own import path (_import_one_file)
                        wrote, so the dataset actually boots and renders.

Rebuild / extend:
    uv run python webapp/tests/build_subagent_fixture.py          # rebuild from scratch
A human can REPLACE this fixture with real data later and give it its own backup lineage
(e.g. point litestream at a copy of this dir) — deploy.py's `--data-mode fixture` just copies
whatever is in the fixture dir into the test volume; it never reaches for prod.

NOTE: 'reproducible' here means the builder deterministically regenerates an equivalent dataset
(fixed ids, fixed timestamps, fixed synthetic pixels) — not that app.db is byte-identical run to
run (SQLite page layout can vary). The image content hashes ARE stable (content-addressed).
"""
from __future__ import annotations

import shutil
import sqlite3
from pathlib import Path

from PIL import Image, ImageDraw
from werkzeug.security import generate_password_hash

REPO = Path(__file__).resolve().parents[2]
FIXTURE_DIR = REPO / 'webapp' / 'tests' / 'fixtures' / 'subagent_dataset'

# Fixed, synthetic credentials — NOT secret (this is a committed test fixture).
ADMIN_PASSWORD = 'subagent-admin-pw'
ANNOTATOR_USERNAME = 'subagent'
ANNOTATOR_PASSWORD = 'subagent-pw'
FIXED_TS = '2020-01-01T00:00:00Z'          # fixed so rebuilds are as deterministic as possible
PROJECT_ID = 'subagent-demo-project'


def _synthetic_png(seed: int) -> bytes:
    """A small, deterministic leaf-ish PNG: pale background + a couple of dark blobs so the
    leaf-bbox / tiling pipeline has real content to chew on. Pure function of `seed`."""
    import io

    img = Image.new('RGB', (240, 180), (232, 236, 220))
    draw = ImageDraw.Draw(img)
    # A green leaf body + darker 'lesion' spots, positioned deterministically from seed.
    draw.ellipse((30, 30, 210, 150), fill=(96, 140, 70))
    for i in range(3):
        cx = 60 + (seed * 37 + i * 53) % 120
        cy = 55 + (seed * 29 + i * 41) % 70
        draw.ellipse((cx, cy, cx + 22, cy + 22), fill=(70, 45, 35))
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return buf.getvalue()


def build() -> None:
    # Import inside build() so a mere import of this module has no side effects.
    from webapp.app import create_app
    from webapp.config import AppConfig
    from webapp.seed import seed_data
    from webapp import db as _db
    from webapp import projects as _projects
    from webapp import taxonomy

    if FIXTURE_DIR.exists():
        shutil.rmtree(FIXTURE_DIR)
    FIXTURE_DIR.mkdir(parents=True)

    cfg = AppConfig(
        data_dir=FIXTURE_DIR,
        db_seed='clean',
        secret_key='subagent-fixture-secret-not-secret',
        admin_password=ADMIN_PASSWORD,     # seeds the 'admin' user on this fresh DB
    )
    seed_data(cfg)
    app = create_app(cfg)                   # builds schema + seeds admin

    with app.app_context():
        con = _db.get_db()
        try:
            # A demo annotator (so a subagent can log in as a non-admin too).
            con.execute(
                'INSERT INTO users (username, password_hash) VALUES (?, ?)',
                (ANNOTATOR_USERNAME, generate_password_hash(ANNOTATOR_PASSWORD)),
            )
            # One demo project (mirrors projects.create_project's INSERT, but session-free).
            classes = taxonomy.normalise_classes('[]')
            con.execute(
                '''INSERT INTO project
                     (id, name, tile_size_px, black_threshold, classes_json,
                      created_by, created_by_user_id, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)''',
                (PROJECT_ID, 'Subagent Demo', 128, 0, taxonomy.dump_classes(classes),
                 'admin', None, FIXED_TS),
            )
            # Import two synthetic images through the app's REAL import path (dedup/store/
            # leaf-bbox/insert) so the on-disk store + rows are exactly what the app expects.
            for i in range(2):
                _projects._import_one_file(
                    con, PROJECT_ID, f'synthetic_leaf_{i}.png', _synthetic_png(i),
                    None, threshold=0, tile_size=128,
                )
            con.commit()
        finally:
            _db.close_db(con)

    _cleanup_strays()
    _report()


def _cleanup_strays() -> None:
    # Drop SQLite WAL/SHM sidecars so the committed fixture is just the settled DB + content.
    for pattern in ('app.db-wal', 'app.db-shm', 'app.db.tmp-*'):
        for stray in FIXTURE_DIR.glob(pattern):
            stray.unlink(missing_ok=True)


def _report() -> None:
    con = sqlite3.connect(FIXTURE_DIR / 'app.db')
    try:
        users = con.execute('SELECT count(*) FROM users').fetchone()[0]
        projects = con.execute('SELECT count(*) FROM project').fetchone()[0]
        images = con.execute('SELECT count(*) FROM project_image').fetchone()[0]
    finally:
        con.close()
    imgs_on_disk = len(list((FIXTURE_DIR / 'images').rglob('*'))) if (FIXTURE_DIR / 'images').exists() else 0
    print(f'[fixture] built {FIXTURE_DIR.relative_to(REPO)}: '
          f'{users} users, {projects} project(s), {images} image row(s), '
          f'{imgs_on_disk} stored image file(s).')
    print('[fixture] admin / subagent logins seeded; disjoint from prod by construction.')


if __name__ == '__main__':
    build()
