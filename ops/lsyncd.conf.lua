-- lsyncd config: one-way additive mirror of leaf-annotation files to the backup volume.
-- Runs inside a Docker container: source=/data (leaf-data volume), target=/backup/files.
-- app.db is excluded (replicated by litestream); only images/, jsons/, manifest.json.
-- no-delete: a local mishap cannot wipe the backup.

settings {
    -- /var/log is root-owned; lsyncd now runs as PUID:PGID (non-root, per the no-sudo
    -- ownership-flip design) and can't create a logfile there — it would crash at startup
    -- with "Cannot open logfile [/var/log/lsyncd.log]". /dev/stdout is world-writable and is
    -- standard container practice: the log lands in `docker logs lsyncd` instead.
    logfile    = "/dev/stdout",
    -- Written under /var/run/lsyncd/ (a dedicated subdir, not bare /var/run) so it can be
    -- shared read-only to the backup-status sidecar via one small volume (compose.yaml's
    -- `lsyncd-status` volume) without exposing anything else in /var/run. lsyncd rewrites
    -- this file on its own heartbeat (statusInterval, default 10s) regardless of activity,
    -- so its header timestamp is a live "lsyncd is alive as of T" signal the sidecar parses
    -- — see docs/plans/Plan — Admin sync-status panel.md (DECISION: sidecar, 2026-07-01).
    statusFile = "/var/run/lsyncd/status",
    nodaemon   = true,
}

sync {
    default.rsync,
    source = "/data/",
    target = "/backup/files/",
    -- lsyncd's `delete` defaults to TRUE — it mirrors source deletions onto the target. We MUST
    -- force it false so a local deletion / mishap can never wipe the backup. NOTE: `delete` is a
    -- SYNC-level option, not an rsync-table key (putting it under `rsync` errors at startup with
    -- "Parameter 'rsync.delete' unknown" — that trap does NOT mean lsyncd won't delete).
    delete = false,
    rsync = {
        archive = true,
        -- app.db* covers the DB + WAL/SHM + litestream's app.db.tmp-* temp files (the DB is
        -- litestream's job, not the file mirror's); the hidden shadow dir needs its own pattern.
        _extra  = { "--exclude=app.db*", "--exclude=.app.db-litestream/" },
    },
}
