-- lsyncd config: one-way additive mirror of leaf-annotation files to the backup volume.
-- Runs inside a Docker container: source=/data (leaf-data volume), target=/backup/files.
-- app.db is excluded (replicated by litestream); only images/, jsons/, manifest.json.
-- no-delete: a local mishap cannot wipe the backup.

settings {
    logfile    = "/var/log/lsyncd.log",
    statusFile = "/var/run/lsyncd.status",
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
