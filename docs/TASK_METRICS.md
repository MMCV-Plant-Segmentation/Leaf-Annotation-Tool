# Subagent task metrics

Per-task token / tool-use tracking for dispatched subagents, so we can see cost trends and catch
runaway *or* starved tasks. Add a row when an agent finishes — the numbers come from its completion
notification (final message reports total tokens + tool uses). Tracking started 2026-07-01, so
earlier agents are unrecorded (`—`); the merge commit is the reliable record for those.

| Date | Task | Branch | Model | Tokens | Tool uses | Outcome |
|------|------|--------|-------|-------:|----------:|---------|
| 2026-07-01 | Pre-flight upload hashing (attempt 1) | feature/preflight-hash | Sonnet 5 | 647 | 24 | ❌ died — hit session limit before starting; 0 commits |
| 2026-07-01 | Pre-flight upload hashing (build) | feature/preflight-hash | Sonnet 5 | ~212,980 | 171 | ✅ merged 1d24de3 — gate 13/13 BE, 332 Playwright; needed a 2nd window (stalled on a backgrounded gate) |
| 2026-07-01 | Version everything (stack-wide) | feature/versioning | Sonnet 5 | 114,989 | 117 | ✅ merged 101de63 — gate 14/14 BE, 336 Playwright; clean single window |
| 2026-07-01 | Adopt Alembic (baseline, stage 1/2) | task/alembic-baseline | Sonnet 5 | 154,111 | 93 | ✅ merged 776e1b8 — gate 15/15 BE, 336 Playwright; validated stamp against real prod snapshot |
| 2026-07-01 | Backup sync-status sidecar | feature/sync-status-sidecar | Sonnet 5 | 108,661 | 123 | ✅ merged cd1d915 (commit 6773a04) — gate 15/15 BE, 342 Playwright; needed a 2nd window (gate-stall); crossed Alembic merge cleanly |
| 2026-07-01 | Annotation/stroke fused-mask model (stage 2/2) | feature/annotation-mask-model | Sonnet 5 | 411,285 | 200 | ✅ merged 21bd1da (1263abf+60cb352) — gate 15/15 BE, 333 Playwright; migration validated vs prod snapshot (316→298, idempotent md5, downgrade tested); biggest task by far |
| 2026-07-02 | SPEC §10 catch-up (fused-mask + infra) | task/spec-catchup | Sonnet 5 | 93,909 | 42 | ✅ merged 4c1533a (f7e5008) — gate 16/16 BE, 339 PW; docs-only, verified vs code |
| 2026-07-02 | Lock fused-mask invariants (test audit) | task/fused-mask-tests | Sonnet 5 | ~77,368+ | 29+ | ✅ merged 531f4aa (d74ecd2) — gate 16/16 BE, 339 PW; 2 windows (gate-stall); added only the missing redo test |
| 2026-07-02 | Eraser fills self-intersecting loops | fix/eraser-fill | Sonnet 5 | ~99,339 | 70 | ✅ merged b4ffcd9 (7b00170) — gate 16/16 BE, 339 PW; 2 windows (55,699/34 + 43,640/36, gate-stall) |
| 2026-07-02 | Image/overlay lockstep (decode gate) | fix/image-lockstep | Sonnet 5 | 45,308 | 30 | ✅ merged 6128af5 (60d9b02) — gate 16/16 BE, 339 PW; clean single window |
| 2026-07-02 | Entrypoint env hygiene + env-read ban | fix/env-hygiene | Sonnet 5 | 102,472 | 85 | ✅ merged 5f1a6fb (cf1bc9c) — gate 18/18 BE, 339 PW; had to repair a corrupt NFS venv |
| 2026-07-02 | /train mode picker regression | fix/train-mode | Sonnet 5 | 133,652 | 97 | ✅ merged 1098e28 (06180f8) — gate 16/16 BE, 341 PW; root-caused a display:none Kobalte bug, not the removed control I guessed |
| 2026-07-02 | Brush UX accessibility (visibility + log slider) | feature/brush-ux | Sonnet 5 | 69,364 | 27 | ✅ merged 0156208 — Opus-run gate 341 PW; NO stall (didn't run gate); scope held |
| 2026-07-02 | Self-service Settings (username/password) | feature/user-settings | Sonnet 5 | 78,138 | 54 | ✅ merged e90193e — Opus-run gate 19/19 BE + 341 PW; NO stall; scope held |
| 2026-07-02 | GET /api/health (FIRST GLM run) | task/health-endpoint | GLM-5.2 via Haiku relay | **8,269** | 1 | ✅ merged 338012d — gate 20/20 BE + 341 PW. Claude cost = just the Haiku relay (8.3k tok / 1 tool); GLM-5.2 did the coding (0 Claude tokens). ~1/10th a Sonnet task. |
| 2026-07-03 | Escape deselects tool → pan (FIRST OpenRouter run) | fix/escape-deselect-tool | GLM-5.2 via OpenRouter/Z.AI | **0 Claude** | 0 | ✅ merged 626845c — gate 20/20 BE + 341 PW. Ran GLM directly (no Haiku relay), so 0 Claude tokens. GLM: 9,099 tok (cached 5,952) = **$0.0066** on Z.AI. OpenRouter reports real $ per call now. |
| 2026-07-03 | Viewport telemetry (pan/zoom recording) | feat/viewport-telemetry | Sonnet 5 | 108,257 | 79 | ⏳ reviewed by Opus, gate ALL GREEN (21/21 BE + 341 PW); NOT merged — awaiting Christian's sign-off (real research-data schema). Flagged: admin session records no telemetry unless it passes `annotator`; pre-existing `data/app.db` legacy fixture crashes the PW gate stage repo-wide. Routed to Sonnet not GLM (jail dep-baking gap). |
| 2026-07-03 | Admin canvas read-only in annotator view (FE-only) | fix/admin-annotator-readonly | GLM-5.2 (jail, Layer 1) | **0 Claude** | 0 | ✅ merged 3cd7358 — gate 20/20 BE + 341 PW. **FIRST real GLM feature in the Docker jail** (after the dep-baking + Node-24 fixes); GLM self-validated `tsc` + `vite build` OFFLINE in the box, wrote a clean 2-file diff in scope. GLM: 113,059 tok (cached 98,944) = **$0.0575**. 0 Claude tokens — ran glm_agent directly, no Haiku relay. |
| 2026-07-04 | Env-unification finish (app.config.toml + gate-on-primitives + synthetic subagent fixture) | feat/env-unification→main | Sonnet 5 | 247,441 | 103 | ✅ merged aff9ce3 (+ scripts/ tracked, gate.sh removed) — gate 21/21 BE + 341 PW; warm-resumed the decouple-from-prod agent. |
| 2026-07-04 | Prod first-boot (compose.backup.yaml split so plain prod needs no BACKUP_DIR + first-boot volume chown) | fix/prod-firstboot→main | Sonnet 5 | 96,022 | 51 | ✅ merged cd3ee1a — gate 21/21 BE + 341 PW; validated isolated (COMPOSE_PROJECT_NAME=leaf-fbtest), real prod untouched. Fresh Sonnet (not warm-resume) → cheap. Flagged pre-existing lsyncd logfile crash-loop (out of scope). |
| 2026-07-04 | Fix --with-backup sidecars (lsyncd logfile→/dev/stdout + chown lsyncd-status volume on first boot) | fix/backup-sidecars | Sonnet 5 | — | — | ⏳ dispatched — non-root lsyncd crashed on root-owned /var/log logfile + root-owned lsyncd-status volume; prod found running app-only (backups off since Jul 2). |
| 2026-06-30 | Quarantine legacy app.js | task/quarantine-app-js | Sonnet 5 | — | — | ✅ merged 40151e6 (not recorded) |
| 2026-06-30 | Brush eraser (battle-test) | feature/brush-eraser | Sonnet 5 | — | — | ✅ merged f6cb6eb (not recorded) |
| 2026-06-30 | Admin read-only viewer (battle-test) | feature/admin-viewer | Sonnet 5 | — | — | ✅ merged 151bbe3 (not recorded) |
| 2026-06-30 | Upload polish | feature/upload-polish | Sonnet 5 | — | — | ✅ merged 7dede02 (not recorded) |

The pre-flight "build" figure sums two work windows (107,773 tok / 83 tools, then 105,207 / 88); the
initial 647/24 attempt died separately.

> **Source of the numbers:** the harness's `<usage>` block in each task-completion notification —
> NOT the agent's self-report. Agents cannot read their own token/tool counters (this one said so
> outright), so asking them to report it in-message doesn't work; read `<usage>` instead.
