# PROCEDURE — how we ship features

The standing workflow for the Opus↔Sonnet implementer loop. (Mechanics of the loop itself live in
`Plan — Opus-Sonnet implementer loop.md`; this doc is the day-to-day procedure.)

## Roles
- **Opus (Claude Code, primary):** plans, gates, and **commits**. Writes the task docs that brief
  Sonnet, independently verifies Sonnet's work before accepting it, and authors the commits.
- **Sonnet (background subagent):** implements. Completes a **whole plan autonomously** — or a
  **specified range** of it when a plan isn't fully baked, or has tricky parts that TDD can't cover —
  then hands back. Never commits.
- **Christian:** sets direction, approves feature-level plans, polishes. Does **not** need to commit
  (Opus writes the commits).

## Cadence
1. Opus writes a task doc in `docs/` (TDD where possible) and briefs Sonnet.
2. Sonnet implements the **full plan or the agreed range** autonomously, runs **`uv run python scripts/gate.py`**
   as the final step, and reports the digest. Opus does **not** interrupt mid-plan.
3. Opus **gates token-cheaply** — see *Gating* below. On green, Opus **commits** the phase.

## Gating (token-cheap)
The gate is automated in **`scripts/gate.py`** (run it with `uv run python scripts/gate.py`): backend
suites (auto-discovered from `webapp/tests/test_*.py`) + tsc + lint + build + full Playwright (against a
managed non-forking server), with verbose output in log files and only a compact digest on stdout — the
default digest includes per-stage PASS/FAIL, **test counts**, and the **names of any failures**. `-v`
tails each stage's log; `-q` prints only the summary. **Opus runs the gate, NOT Sonnet**
(changed 2026-07-02): Sonnet reliably backgrounds `scripts/gate.py` and stalls waiting for a completion
signal that never reaches it, and each warm resume re-bills Sonnet's whole context (50–130k tokens — the
single biggest token drain we've seen). Sonnet instead runs only its OWN targeted tests (`uv run python3
webapp/tests/<the-file-it-wrote>.py`, foreground) to self-check, then reports what it changed; Opus runs
the one authoritative `uv run python scripts/gate.py` in the worktree.

**The gate is concurrency-safe** — it uses an **ephemeral port** (bind `:0`) and a **per-run temp dir**
(its own `HT_DATA_DIR` / Playwright fixture dir / `storageState`), so two gates can run at the same time
without colliding. Sonnets no longer need to be serialized for gating: plan ranges / features can gate
in parallel.

Instead, Opus verifies cheaply:
- **Review the test diff** to confirm Sonnet didn't weaken, delete, or trivialise existing tests, and
  that any new tests actually assert the intended behaviour. Reading a diff is far cheaper than
  re-running a server + suite. This is the "guarantee the tests weren't gutted" check.
- **Run `uv run python scripts/gate.py` in the worktree yourself** as the authoritative pass/fail (one bash
  call → compact digest; cheaper than a Sonnet stall-resume). Pair it with the test-diff review above.

Keep the gate authoritative: anything Opus finds itself checking by hand twice should be **folded into
`scripts/gate.py` or the test suite** so it's covered automatically next time, not re-typed.

4. On green, Opus **commits** the gated phase onto the feature branch.

## Branching & commits
- **One branch per feature** (`feat/<name>`), cut **at the start** of a new feature. **Never branch
  mid-feature** — if work is already underway on a branch (or on the default branch), keep going there
  and amend/extend; don't replant it.
- The whole feature arc — redesign + every polish pass — lives on that one branch and never touches
  the default branch until it's done.
- **Commit each gated phase on the branch**, including polish iterations. Each commit is a real
  checkpoint you can diff/revert; this is how we "keep track of changes" without the main-line
  pile-up that caused trouble before.
- **More commits don't change the gate cadence.** A phase is still one autonomous Sonnet run + one
  Opus gate; the commit is just the checkpoint at the end of it.
- **Squash is a merge-time decision, not now.** When the feature is done, choose squash-to-one vs.
  preserve-the-phases. Default: preserve if the history is coherent and useful. **We can always
  squash** if the history got messy along the way.

## Plans vs. durable docs
- **Task/Plan docs are throwaway working docs** — kept in `docs/`, **never committed** (see
  `[[feedback-no-commit-plans]]`). Completed work is recorded in `SPEC.md`.
- **Archive completed task docs.** Once a task doc's work is gated, committed, and its outcome recorded
  in `SPEC.md`, **move the doc to `docs/archive/`** so `docs/` only holds live working docs. Do this as
  part of accepting a phase — don't let finished task docs pile up at the top level.
- **This file and other standing procedure/reference docs are durable** and may be committed.

## Task docs — how Opus briefs Sonnet
A task doc is a **precise, self-contained brief**: Sonnet should be able to implement the whole thing
without searching for context. The goal is token frugality on *both* sides — a vague brief makes Sonnet
wander and read files it doesn't need.
- **Name the exact files, functions, and approximate line areas** to touch (e.g. "`import_images`
  ~line 412 in `webapp/projects.py`"). Tell Sonnet to use **targeted `grep`/`sed`**, and to **never
  read the big files whole** (`webapp/app.py` ~1098 lines, `webapp/projects.py` ~929) — the guard hook
  enforces this, but say it anyway.
- **State the conventions every time** (the standing preamble): `uv run …` always (never bare
  `python3`); frontend is SolidJS + TypeScript + Vanilla Extract `.css.ts` with **no string class
  literals**; backend tests are **standalone scripts** (`uv run python3 webapp/tests/<name>.py`), not
  pytest; **do NOT run `scripts/gate.py`** — you reliably background it and stall (Opus runs the gate).
  Run only the specific `webapp/tests/<file>.py` you touched (foreground) to self-check, then report
  exactly what you changed; **don't commit** (Opus runs the gate, commits, and merges); keep
  `docs/SONNET_WORKLOG.md` updated; **never** read `reference/NautilusWebPortal`.
- **Structure:** `Fix N` / step sections, an explicit **Out of scope**, and a **Done =** line (gate
  ALL GREEN + the manual checks that prove it).
- **Pair every dispatch with a scope file** — see *Guard rails* below. Be **generous**: directory
  globs, not file lists, so Sonnet never has to restructure around a missing path.

## Frugality — keeping subagent token cost down
The subagent is the dominant token sink (each warm resume re-bills its whole context; a warm agent
ballooned to ~289k tokens). Standing rules:
- **Fresh agent per independent task.** Spin up a new Sonnet scoped to one task rather than warm-resuming
  one agent across many. **Warm-resume only for revisions on the *same* task** (cache is still warm).
- **Front-load everything** in the task doc so the agent doesn't burn tokens searching — see above.
- **Opus runs the gate, not Sonnet** (see *Gating*). Sonnet backgrounding `scripts/gate.py` + stalling,
  then a warm resume re-billing its whole context, was the single biggest token drain — removed by taking
  the full gate off Sonnet entirely.
- **Opus does tiny fixes directly.** Dispatch overhead dwarfs a few-line change; don't spawn for those.
- **Never read raw agent transcripts / giant JSON in full** — use `grep`/`jq`/scoped reads.

## Guard rails — the PreToolUse hook
A `PreToolUse` hook (`.claude/hooks/guard.py`, local/gitignored, stdlib-only, **fail-open**) backs the
two rules above so they aren't just honour-system:
- **Frugal reads (all agents, incl. Opus):** a whole-file `Read` of a text file longer than
  `HT_READ_MAX_LINES` (default 400) with no `offset`/`limit` is **denied** — read a slice or `Grep`
  first. Binary/image reads and reads that already pass `limit` are unaffected.
- **Subagent file scope (Sonnet only):** the hook fires inside a subagent (detected by the `agent_id`
  field, which main-agent calls lack), and **only when `.claude/agent_scope.json` exists**. It confines
  the subagent's Edit/Write to `write_allow` globs and keeps its Reads out of `read_deny` (the Nautilus
  reference, secrets). Main-agent (Opus) calls are never restricted; absent a scope file, nothing is.
- **Workflow:** Opus copies `agent_scope.example.json` → `agent_scope.json` (generous directory globs)
  right before dispatching, and removes it once the run is accepted. The deny message tells Sonnet to
  **ask Opus to widen scope rather than work around it** — deliberate, since Sonnet invents hacky
  workarounds under unreasonable constraints.
- **Caveat (single global scope):** `agent_scope.json` describes ONE scope, so it's clean for
  sequential dispatch but a shared union for parallel agents in separate worktrees. Fail-closed +
  per-agent scoping is filed in `RAINYDAY.md`. **This is easy to forget** (it was skipped for the whole
  2026-07-02 fix batch) — hence the checklist below.

## Dispatch checklist (do EVERY spawn — don't skip)
At the moment Opus fires a subagent, before the Agent call:
1. **Write `.claude/agent_scope.json`** (generous directory globs for `write_allow`) so the guard
   actually confines the agent's writes. Remove it once the run is merged/accepted.
2. **Append a stub row to `docs/TASK_METRICS.md`** — date / task / branch / model, tokens+tools blank.
   Opus writes this at dispatch (dispatch is serial → no concurrency), NOT the subagent, which can't
   read its own counters.
3. Dispatch (fresh Sonnet, one task; see Frugality).

On completion: **fill the stub's tokens/tool-uses from the notification `<usage>` block** (the only
reliable source), and record the merge SHA + gate digest.
