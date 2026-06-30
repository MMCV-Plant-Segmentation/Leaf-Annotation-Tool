import os, tempfile, json
TMP = tempfile.mkdtemp(prefix='leaf-anno-test-')
os.environ['HT_DATA_DIR'] = TMP
os.environ['SECRET_KEY'] = 'test-secret'

import numpy as np
from PIL import Image
from webapp import db, app as appmod
db.auto_create_schema()
# seed real users so created_by_user_id FK is satisfied (prod always has one) and the
# roster (now a registered-user FK) can reference alice/bob.
_c = db.get_db()
_c.execute("INSERT INTO users (id, username) VALUES (1, 'admin')")
_c.execute("INSERT INTO users (username) VALUES ('alice')")
_c.execute("INSERT INTO users (username) VALUES ('bob')")
_c.commit()
_USER_ID = {r['username']: r['id'] for r in _c.execute('SELECT id, username FROM users').fetchall()}
db.close_db(_c)
app = appmod.app
app.secret_key = 'test-secret'
client = app.test_client()

# fake login
with client.session_transaction() as s:
    s['user_id'] = 1
    s['username'] = 'admin'

def jdump(r):
    return r.get_json()

# Make two synthetic leaf images on disk
img_dir = os.path.join(TMP, 'src_images'); os.makedirs(img_dir, exist_ok=True)
for n, (lw, lh) in enumerate([(200,140),(160,160)]):
    arr = np.zeros((220, 280), np.uint8)
    arr[30:30+lh, 40:40+lw] = 210
    Image.fromarray(arr,'L').save(os.path.join(img_dir, f'leaf{n}.png'))

# 1) create project
r = client.post('/api/projects', json={'name':'Maize 2026','tile_size_px':64,'black_threshold':50,'classes':['lesion','midrib']})
assert r.status_code == 201, r.get_json()
pid = jdump(r)['id']
print('project created', pid, 'classes=', jdump(r)['classes'])

# 2) roster (registered-user FK: add by user_id)
for b in ['alice','bob']:
    r = client.post(f'/api/projects/{pid}/annotators', json={'user_id': _USER_ID[b]}); assert r.status_code==201, jdump(r)
# duplicate -> 409
assert client.post(f'/api/projects/{pid}/annotators', json={'user_id': _USER_ID['alice']}).status_code==409
print('roster ok (alice,bob; dup rejected)')

# 3) import images from dir
r = client.post(f'/api/projects/{pid}/images/import', json={'path': img_dir})
assert r.status_code==200, jdump(r)
imp = jdump(r); print('import:', imp)
assert imp['imported']==2 and imp['skipped']==0 and not imp['errors']
# re-import -> all skipped
assert jdump(client.post(f'/api/projects/{pid}/images/import', json={'path': img_dir}))['skipped']==2
print('re-import skips dupes ok')

# 4) project detail + preview
det = jdump(client.get(f'/api/projects/{pid}'))
assert len(det['images'])==2 and len(det['annotators'])==2  # alice + bob (admin creator is NOT auto-added)
img0 = det['images'][0]
pv = jdump(client.get(f'/api/projects/{pid}/images/{img0["id"]}/tiles/preview?black_threshold=50'))
print('preview tiles for img0:', len(pv['tiles']), 'leafBbox=', pv['leafBbox'])
assert len(pv['tiles'])>0
# slider: a very high threshold should drop tiles
pv_hi = jdump(client.get(f'/api/projects/{pid}/images/{img0["id"]}/tiles/preview?black_threshold=250'))
assert len(pv_hi['tiles']) <= len(pv['tiles'])
print('threshold slider reduces tiles ok', len(pv['tiles']),'->',len(pv_hi['tiles']))

# 5) create a batch of 4
r = client.post(f'/api/projects/{pid}/batches', json={'size':4}); assert r.status_code==201, jdump(r)
batch = jdump(r); bid = batch['id']
print('batch:', batch)
assert batch['tileCount'] >= 1 and batch['rosterSize']==2  # alice + bob (admin creator is NOT auto-added)

# 6) canvas read for alice
cv = jdump(client.get(f'/api/batches/{bid}?annotator=alice'))
assert cv['images'], cv
total_tiles = sum(len(im['tiles']) for im in cv['images'])
print('canvas: images=', len(cv['images']), 'tiles=', total_tiles)
# pick an image+tile to draw inside
target = cv['images'][0]; t0 = target['tiles'][0]
print('drawing inside tile', t0['x'],t0['y'],t0['w'],t0['h'])

# 7) create annotation (polygon) intersecting that tile
poly = [[t0['x']+2,t0['y']+2],[t0['x']+t0['w']-2,t0['y']+2],[t0['x']+t0['w']-2,t0['y']+t0['h']-2],[t0['x']+2,t0['y']+t0['h']-2]]
r = client.post(f'/api/projects/{pid}/annotations', json={'imageId':target['imageId'],'annotator':'alice','kind':'polygon','passNo':2,'points':poly,'label':'lesion','viewport':{'x':t0['x'],'y':t0['y'],'w':t0['w'],'h':t0['h']}})
assert r.status_code==201, jdump(r)
ann = jdump(r); print('annotation created, tiles touched:', ann['tileIds'])
assert t0['tileId'] in ann['tileIds']

# annotation outside any tile -> 422
r = client.post(f'/api/projects/{pid}/annotations', json={'imageId':target['imageId'],'annotator':'alice','kind':'point','points':[[9999,9999]]})
assert r.status_code==422, jdump(r)
print('out-of-tile annotation rejected (422) ok')

# 8) complete the tile, check progress
at_id = None
# fetch annotator_tile id via canvas? need it: get from batch_tile/annotator_tile. Use a direct API: state toggle needs at_id.
con = db.get_db()
at_id = con.execute("SELECT at.id FROM annotator_tile at JOIN batch_tile bt ON bt.id=at.batch_tile_id WHERE bt.tile_id=? AND at.annotator='alice'", (t0['tileId'],)).fetchone()['id']
db.close_db(con)
assert jdump(client.patch(f'/api/annotator-tiles/{at_id}', json={'state':'completed'}))['state']=='completed'
prog = {p['annotator']:p for p in jdump(client.get(f'/api/projects/{pid}'))['progress']}
print('progress alice:', prog['alice'])
assert prog['alice']['tilesCompleted']==1
assert prog['alice']['lesionCount']==1
assert prog['alice']['vertexCount']==4

# 9) edit annotation -> tile goes dirty
client.patch(f'/api/annotations/{ann["id"]}', json={'points':[[p[0]+1,p[1]+1] for p in poly]})
con = db.get_db()
state = con.execute('SELECT state FROM annotator_tile WHERE id=?', (at_id,)).fetchone()['state']
db.close_db(con)
print('after edit, tile state =', state)
assert state=='dirty', 'editing a completed tile should dirty it'

# 10) blindness: bob sees no annotations
cv_bob = jdump(client.get(f'/api/batches/{bid}?annotator=bob'))
bob_anns = sum(len(im['annotations']) for im in cv_bob['images'])
assert bob_anns==0, 'bob must be blind to alice'
print('cross-annotator blindness ok (bob sees', bob_anns,'annotations)')

# 11) image serving
r = client.get(f'/api/projects/images/{target["imageId"]}/overview'); assert r.status_code==200 and r.mimetype=='image/png'
r = client.get(f'/api/projects/images/{target["imageId"]}/crop?x={t0["x"]}&y={t0["y"]}&w={t0["w"]}&h={t0["h"]}'); assert r.status_code==200
print('image overview + crop serve PNG ok')

print('\nALL BACKEND TESTS PASSED ✓  (data dir:', TMP, ')')
