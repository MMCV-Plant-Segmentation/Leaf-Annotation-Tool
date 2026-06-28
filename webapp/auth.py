"""Auth, user management, invite, and settings blueprint."""
import os
import secrets
import time
from functools import wraps

from flask import Blueprint, jsonify, request, session
from werkzeug.security import check_password_hash, generate_password_hash

from . import db as _db

auth_bp = Blueprint('auth', __name__)

INVITE_TTL = 604_800  # 7 days in seconds
_ENV_ONLY  = {'DATA_DIR', 'SECRET_KEY', 'ADMIN_PASSWORD'}  # never stored in settings table


# ── Decorators ────────────────────────────────────────────────────────────────

def login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if 'user_id' not in session:
            return jsonify({'error': 'not logged in'}), 401
        return f(*args, **kwargs)
    return wrapper


def admin_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if 'user_id' not in session:
            return jsonify({'error': 'not logged in'}), 401
        if session.get('username') != 'admin':
            return jsonify({'error': 'admin required'}), 403
        return f(*args, **kwargs)
    return wrapper


# ── Auth ──────────────────────────────────────────────────────────────────────

@auth_bp.post('/api/login')
def api_login():
    body     = request.json or {}
    username = (body.get('username') or '').strip()
    password = body.get('password') or ''
    con      = _db.get_db()
    try:
        row = con.execute(
            'SELECT id, username, password_hash FROM users WHERE username = ?', (username,)
        ).fetchone()
    finally:
        _db.close_db(con)
    if not row or not row['password_hash'] or not check_password_hash(row['password_hash'], password):
        return jsonify({'error': 'Invalid username or password'}), 401
    session.clear()
    session['user_id']  = row['id']
    session['username'] = row['username']
    return jsonify({'ok': True})


@auth_bp.post('/api/logout')
@login_required
def api_logout():
    session.clear()
    return jsonify({'ok': True})


@auth_bp.get('/api/me')
def api_me():
    if 'user_id' not in session:
        return jsonify(None)
    return jsonify({
        'id':       session['user_id'],
        'username': session['username'],
        'is_admin': session.get('username') == 'admin',
    })


# ── User management ───────────────────────────────────────────────────────────

def _make_invite(con, user_id: int) -> dict:
    token   = secrets.token_urlsafe(32)
    expires = time.time() + INVITE_TTL
    con.execute(
        'INSERT INTO invite_codes (user_id, token, expires) VALUES (?, ?, ?)',
        (user_id, token, expires),
    )
    return {'token': token, 'expires': expires}


def _latest_invite(con, user_id: int) -> dict | None:
    row = con.execute(
        'SELECT token, expires FROM invite_codes WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
        (user_id,),
    ).fetchone()
    return {'token': row['token'], 'expires': row['expires']} if row else None


@auth_bp.get('/api/users/members')
@login_required
def api_users_members():
    """Non-admin roster autocomplete: returns only {id, username}.

    Does NOT return password_hash, invite state, or any sensitive field.
    Use GET /api/users (admin-only) for the full user-management list.
    """
    q = (request.args.get('q') or '').strip()
    con = _db.get_db()
    try:
        if q:
            rows = con.execute(
                'SELECT id, username FROM users WHERE username LIKE ? ORDER BY username LIMIT 20',
                (f'%{q}%',),
            ).fetchall()
        else:
            rows = con.execute('SELECT id, username FROM users ORDER BY username').fetchall()
    finally:
        _db.close_db(con)
    return jsonify([{'id': r['id'], 'username': r['username']} for r in rows])


@auth_bp.get('/api/users')
@admin_required
def api_users():
    con = _db.get_db()
    try:
        rows = con.execute(
            'SELECT id, username, password_hash FROM users ORDER BY id'
        ).fetchall()
        out = [
            {
                'id':           r['id'],
                'username':     r['username'],
                'has_password': r['password_hash'] is not None,
                'invite':       _latest_invite(con, r['id']),
            }
            for r in rows
        ]
    finally:
        _db.close_db(con)
    return jsonify(out)


@auth_bp.post('/api/users')
@admin_required
def api_create_user():
    body     = request.json or {}
    username = (body.get('username') or '').strip()
    if not username:
        return jsonify({'error': 'username required'}), 400
    con = _db.get_db()
    try:
        if con.execute('SELECT 1 FROM users WHERE username = ?', (username,)).fetchone():
            return jsonify({'error': 'username already exists'}), 409
        cur     = con.execute('INSERT INTO users (username) VALUES (?)', (username,))
        user_id = cur.lastrowid
        invite  = _make_invite(con, user_id)
        con.commit()
    finally:
        _db.close_db(con)
    return jsonify({'id': user_id, 'username': username, 'has_password': False, 'invite': invite}), 201


@auth_bp.post('/api/users/<int:user_id>/reset')
@admin_required
def api_reset_user(user_id: int):
    con = _db.get_db()
    try:
        row = con.execute('SELECT username FROM users WHERE id = ?', (user_id,)).fetchone()
        if not row:
            return jsonify({'error': 'user not found'}), 404
        if row['username'] == 'admin':
            return jsonify({'error': 'cannot reset admin via UI'}), 403
        con.execute('UPDATE users SET password_hash = NULL WHERE id = ?', (user_id,))
        con.execute('DELETE FROM invite_codes WHERE user_id = ?', (user_id,))
        invite = _make_invite(con, user_id)
        con.commit()
    finally:
        _db.close_db(con)
    return jsonify({'ok': True, 'invite': invite})


@auth_bp.delete('/api/users/<int:user_id>')
@admin_required
def api_delete_user(user_id: int):
    con = _db.get_db()
    try:
        row = con.execute('SELECT username FROM users WHERE id = ?', (user_id,)).fetchone()
        if not row:
            return jsonify({'error': 'user not found'}), 404
        if row['username'] == 'admin':
            return jsonify({'error': 'cannot delete admin'}), 403
        con.execute('DELETE FROM users WHERE id = ?', (user_id,))
        con.commit()
    finally:
        _db.close_db(con)
    return jsonify({'ok': True})


# ── Invite ────────────────────────────────────────────────────────────────────

@auth_bp.get('/api/invite/<token>')
def api_get_invite(token: str):
    con = _db.get_db()
    try:
        row = con.execute(
            'SELECT ic.expires, u.username'
            ' FROM invite_codes ic JOIN users u ON u.id = ic.user_id'
            ' WHERE ic.token = ?',
            (token,),
        ).fetchone()
    finally:
        _db.close_db(con)
    if not row or row['expires'] < time.time():
        return jsonify({'error': 'invalid or expired invite'}), 403
    # Opening an invite link logs out whoever was active (e.g. the admin who minted it in
    # this browser), so the invitee always proceeds as a clean, logged-out session.
    session.clear()
    return jsonify({'username': row['username']})


@auth_bp.post('/api/invite/<token>')
def api_accept_invite(token: str):
    body     = request.json or {}
    password = body.get('password') or ''
    confirm  = body.get('confirm') or ''
    if password != confirm:
        return jsonify({'error': 'passwords do not match'}), 400
    if len(password) < 8:
        return jsonify({'error': 'password must be at least 8 characters'}), 400
    con = _db.get_db()
    try:
        row = con.execute(
            'SELECT id, expires, user_id FROM invite_codes WHERE token = ?', (token,)
        ).fetchone()
        if not row or row['expires'] < time.time():
            return jsonify({'error': 'invalid or expired invite'}), 403
        con.execute(
            'UPDATE users SET password_hash = ? WHERE id = ?',
            (generate_password_hash(password), row['user_id']),
        )
        con.execute('DELETE FROM invite_codes WHERE id = ?', (row['id'],))
        con.commit()
    finally:
        _db.close_db(con)
    # Drop whatever session was active (e.g. the admin who minted the invite in this browser)
    # so the new user lands on a clean /login instead of being bounced back as admin.
    session.clear()
    return jsonify({'ok': True})


# ── Settings ──────────────────────────────────────────────────────────────────

def get_setting(key: str, env_default: str = '') -> str:
    """Read a setting: DB value wins over env default."""
    con = _db.get_db()
    try:
        row = con.execute('SELECT value FROM settings WHERE key = ?', (key,)).fetchone()
    finally:
        _db.close_db(con)
    if row and row['value'] is not None:
        return row['value']
    return os.environ.get(key, env_default)


@auth_bp.get('/api/settings')
@admin_required
def api_get_settings():
    env_defaults = {'BACKUP_DIR': os.environ.get('BACKUP_DIR', '')}
    con = _db.get_db()
    try:
        rows = con.execute('SELECT key, value, updated_at FROM settings').fetchall()
    finally:
        _db.close_db(con)
    result = {k: {'value': v, 'updated_at': None} for k, v in env_defaults.items()}
    for r in rows:
        result[r['key']] = {'value': r['value'], 'updated_at': r['updated_at']}
    return jsonify(result)


@auth_bp.patch('/api/settings')
@admin_required
def api_patch_settings():
    body               = dict(request.json or {})
    client_updated_at  = body.pop('updated_at', None)
    con = _db.get_db()
    try:
        if client_updated_at is not None:
            conflict = [
                k for k in body if k not in _ENV_ONLY
                and (row := con.execute('SELECT updated_at FROM settings WHERE key = ?', (k,)).fetchone())
                and row['updated_at'] > client_updated_at
            ]
            if conflict:
                return jsonify({'conflict': conflict}), 409
        now = time.time()
        for key, value in body.items():
            if key in _ENV_ONLY:
                continue
            con.execute(
                'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)'
                ' ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
                (key, value, now),
            )
        con.commit()
    finally:
        _db.close_db(con)
    return jsonify({'ok': True})
