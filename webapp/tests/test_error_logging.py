"""Every client-visible API error (4xx/5xx) must be LOGGED server-side with its message.

The "must intersect at least one tile" 422 (BUGS #31) stayed invisible for a long time: the
server returned a perfectly clear error message to the client, but nothing logged it — the
werkzeug access line shows only an anonymous status code, so the real cause never surfaced in
the server log. A failing test then failed on a downstream symptom instead of the root error.

Fix: an after_request hook logs every /api 4xx/5xx with method + path + status + the error
message, so any client-visible failure is immediately greppable in the server log.
"""
import io
import logging
import os
import tempfile

os.environ['HT_DATA_DIR'] = tempfile.mkdtemp(prefix='leaf-anno-errlog-test-')
os.environ['SECRET_KEY'] = 'test-secret'

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


class _Capture(logging.Handler):
    def __init__(self):
        super().__init__()
        self.records: list[str] = []

    def emit(self, record):
        self.records.append(record.getMessage())


cap = _Capture()
app.logger.addHandler(cap)
app.logger.setLevel(logging.DEBUG)

# Trigger a clean, message-bearing 4xx: a batch on a project with no images → 400.
r = client.post('/api/projects', json={'name': 'ErrLog'})
assert r.status_code == 201, r.get_json()
pid = r.get_json()['id']

r = client.post(f'/api/projects/{pid}/batches', json={'size': 5})
assert r.status_code == 400, f'expected 400, got {r.status_code}: {r.get_json()}'

hits = [m for m in cap.records if '/batches' in m and '400' in m]
assert hits, (
    'no server-side log line for the 400 error — client errors are invisible in the log.\n'
    f'captured records: {cap.records!r}')
line = hits[0]
assert 'POST' in line, f'log line missing HTTP method: {line!r}'
assert 'project has no images' in line, f'log line missing the error message: {line!r}'
print('OK — client-visible 4xx is logged with method/path/status/message:')
print('   ', line)

# A successful request must NOT be logged as an error (no noise on the happy path).
before = len(cap.records)
r = client.get('/api/health')
assert r.status_code == 200
assert not [m for m in cap.records[before:] if 'health' in m], \
    'a 200 response was logged as an error — the hook must only fire on 4xx/5xx'
print('OK — 2xx responses are not error-logged.')

print('\nerror-logging test passed.')
