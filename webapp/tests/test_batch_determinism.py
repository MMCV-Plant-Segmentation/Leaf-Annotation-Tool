"""Batch tile-sampling must be DETERMINISTIC (reproducible), not a per-run coin flip.

`create_batch` shuffles the project's images and samples a random subset of tile positions.
It used the process-global `random`, so batch composition depended on unseeded global RNG
state — different every run, and (worse) consumed in nondeterministic order under the gate's
concurrent test server. That made any test that paints at a fixed spot a coin flip: sometimes
the spot was inside a sampled tile, sometimes not (BUGS #31).

Fix: seed a per-batch `random.Random` from (project_id, seq), so composition is a pure
function of batch identity — identical across runs, in prod and tests, concurrency-safe.

This test creates a batch, records its sampled tiles, then clears the batch+tiles and creates
the batch AGAIN from the identical state (same project_id, seq resets to 1) and asserts the
sample is byte-for-byte identical. RED with the global RNG (the two in-process calls consume
different sequential RNG state), GREEN once the RNG is seeded from batch identity.
"""
import io
import os
import tempfile

os.environ['HT_DATA_DIR'] = tempfile.mkdtemp(prefix='leaf-anno-batchdet-test-')
os.environ['SECRET_KEY'] = 'test-secret'

import numpy as np
from PIL import Image
from webapp import db, app as appmod

db.auto_create_schema()
_c = db.get_db()
_c.execute("INSERT INTO users (id, username) VALUES (2, 'alice')")
_c.commit()
db.close_db(_c)

app = appmod.app
app.secret_key = 'test-secret'
app.testing = True
client = app.test_client()
with client.session_transaction() as s:
    s['user_id'] = 2; s['username'] = 'alice'


def jdump(r):
    return r.get_json()


def _leaf_png(w: int, h: int) -> bytes:
    arr = np.zeros((h, w), np.uint8)
    arr[10:h - 10, 10:w - 10] = 200
    buf = io.BytesIO()
    Image.fromarray(arr, 'L').save(buf, format='PNG')
    return buf.getvalue()


# A big image with a small tile size → many candidate tile positions, so a size=5 batch is a
# genuine random SUBSET (the sampling actually has choices to make).
r = client.post('/api/projects', json={'name': 'BatchDet', 'tile_size_px': 128})
assert r.status_code == 201, jdump(r)
pid = jdump(r)['id']

for i, (w, h) in enumerate([(600, 600), (520, 480), (560, 640)]):
    r = client.post(
        f'/api/projects/{pid}/images/upload',
        data={'files': [(io.BytesIO(_leaf_png(w, h)), f'leaf{i}.png', 'image/png')]},
        content_type='multipart/form-data',
    )
    r.get_data()
    assert r.status_code == 200, jdump(r)


def make_batch_and_read_tiles():
    r = client.post(f'/api/projects/{pid}/batches', json={'size': 5})
    assert r.status_code == 201, jdump(r)
    con = db.get_db()
    try:
        rows = con.execute(
            '''SELECT t.project_image_id, t.x, t.y FROM tile t
               JOIN project_image pi ON pi.id = t.project_image_id
               WHERE pi.project_id = ?''', (pid,)
        ).fetchall()
        return sorted((row['project_image_id'], row['x'], row['y']) for row in rows)
    finally:
        db.close_db(con)


def clear_batches():
    con = db.get_db()
    try:
        con.execute('''DELETE FROM annotator_tile WHERE batch_tile_id IN
                       (SELECT bt.id FROM batch_tile bt JOIN batch b ON b.id = bt.batch_id
                        WHERE b.project_id = ?)''', (pid,))
        con.execute('DELETE FROM batch_tile WHERE batch_id IN '
                    '(SELECT id FROM batch WHERE project_id = ?)', (pid,))
        con.execute('DELETE FROM tile WHERE project_image_id IN '
                    '(SELECT id FROM project_image WHERE project_id = ?)', (pid,))
        con.execute('DELETE FROM batch WHERE project_id = ?', (pid,))
        con.commit()
    finally:
        db.close_db(con)


tiles_1 = make_batch_and_read_tiles()
assert len(tiles_1) == 5, f'expected a 5-tile batch, got {len(tiles_1)}: {tiles_1}'
clear_batches()
tiles_2 = make_batch_and_read_tiles()

assert tiles_1 == tiles_2, (
    'batch tile sampling is NOT deterministic — the same (project, seq) produced different '
    f'tiles across two identical runs:\n  run1={tiles_1}\n  run2={tiles_2}')
print('OK — batch tile sampling is deterministic across identical (project, seq) runs:')
print('   ', tiles_1)
print('\nbatch-determinism test passed.')
