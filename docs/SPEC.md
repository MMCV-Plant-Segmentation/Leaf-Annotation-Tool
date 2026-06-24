# Lesion Annotation Trainer — Specification

Canonical reference for the application as built.

The app opens on a **home screen** of tiles that route to several tools sharing
one backend, one `index.html`, and a byline identity:

1. **Manage Sets** — the set-management UI (upload, rename, replace, delete).
2. **Merge Sets** — the Comparison tool: pool independent annotations from
   several annotators, group them into distinct lesions, reconcile a shared
   truth, and optionally save the result as a `merged` set.
3. **Analyze** — render a footprint k-of-N agreement map over a `merged` (or
   `reannotated`) set, with live agreement-threshold and IoU filters.
4. **Train** — practice annotating to match a reference ("ground truth").
5. **Re-annotate** — *tile disabled.* The collaborative consensus builder is not
   built yet; see [`Consensus Builder Plan.md`](./Consensus%20Builder%20Plan.md).

Forward-looking work lives in two parked docs:
[`Consensus Builder Plan.md`](./Consensus%20Builder%20Plan.md) (the unbuilt
re-annotation tool) and [`Annotator Plan.md`](./Annotator%20Plan.md) (the
labelme-replacement annotator).

---

## 1. Architecture

- **Flask backend** (`webapp/app.py`) serving a single-page web app. The backend
  holds the **annotation-set registry** and **merge documents** in SQLite
  (`app.db`, `webapp/db.py`); **practice (training) session state** still
  lives in the browser's `localStorage`, while **comparison/merge state** is now
  server-persisted in the `merge` table (only the merge ID is kept client-side).
- **Identity (byline):** on first load the user enters a display name (no
  password — attribution, not access control), stored in
  `localStorage['lesion-user']` and sent as an `X-User` header on every `/api/`
  request; the backend records it as `created_by` on creates.
- **Data directory & the local-disk requirement.** All on-disk state — `app.db`,
  `images/`, `jsons/`, `manifest.json` — lives together in one **data directory**,
  which defaults to a **local** path (`$XDG_DATA_HOME/leaf-annotation`, i.e.
  `~/.local/share/leaf-annotation`) and is overridable via `HT_DATA_DIR`. **The
  data directory must be on a local filesystem — never NFS/SMB/FUSE:** SQLite
  relies on POSIX advisory file locking, which is unreliable on network
  filesystems, so with `app.db` on NFS concurrent requests stalled ~30s
  contending for a lock (this was the analyze-reload hang). On first run the
  backend performs a one-time **copy** of any legacy on-NFS `code/data` dir into
  the local data dir (`_migrate_data_to_local`), leaving the old copy in place as
  an interim fallback. Backing the local store up to network/cloud storage is
  handled **out-of-band** (litestream/lsyncd), not by the app.
- **Content-addressed storage**: images at `{data}/images/{sha256[:24]}.{ext}`;
  annotation JSONs at `{data}/jsons/{pair_id}.json`. Images are de-duplicated by
  `image_hash`, so several annotation sets can share one underlying image. The
  registry lives in the `annotation_set` table (`id`, `display_name`,
  `image_hash`, `image_ext`, `kind`, `provenance`, `created_by`, `created_at`,
  `terminal`); `manifest.json` is retained as a read-only backup but is no
  longer authoritative. The `merge` table holds comparison/merge documents (§4).
  `app.db` also contains empty scaffolding tables (`reannot_*`) for the
  unbuilt consensus tool.
- **Frontend is two layers** (see [`Nav Layer to SolidJS Plan.md`](./Nav%20Layer%20to%20SolidJS%20Plan.md)):
  - **Nav/setup layer** — **SolidJS + TypeScript**, source in `webapp/frontend/src/`,
    built by **Vite** to a committed bundle `webapp/static/dist/app.bundle.{js,css}`.
    A Solid **router** (`@solidjs/router`) owns every screen before a viewer launches
    (`/`, `/manage`, `/train`, `/merge`, `/analyze`); **Kobalte** provides the
    accessible widgets and styling is **CSS Modules** over global `:root` tokens. A
    Flask **catch-all** route serves the app shell for any nav path (`/api` and
    `/static` keep priority). The bundle is the runtime artifact — `uv run app.py`
    serves it as-is, so frontend source edits require `npm run build` (a pre-commit
    hook and a startup staleness check enforce this; see HANDOFF.md).
  - **Image viewers** — still multi-file plain `<script>` JavaScript (no ES modules):
    training (`trainer.js`), compare/merge (`compare*.js`). Shared globals; each
    exposes a deferred `initX()` wired from `app.js`. A nav route hands off to the
    vanilla viewer through a small `window._*` bridge. (The **Analyze** viewer is
    itself SolidJS — §5.) The byline modal and the `X-User` fetch wrapper remain
    single-sourced in `app.js`.
- **labelme JSON** (v6.3.1) is the annotation interchange format. Only
  `shape_type == 'polygon'` shapes are used; the `fused_exterior` label is
  excluded.
- **Geometry** is computed server-side with Shapely; images handled with PIL.
- **Browsers cannot render TIFF**, so the comparison tool never points an
  `<img>` at the raw file — it requests server-converted PNGs (see §4.1).

### Run

Launch with `uv run app.py` from `webapp/`. Always use `uv run python3` in this
project (never plain `python3`).

---

## 2. Backend API

### Training endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/api/images` | List available annotation sets (from the `annotation_set` registry). |
| `POST` | `/api/upload` | Upload image + labelme JSON + display name (web upload so SSH-forwarded users need no direct server access). Stamps `created_by` from `X-User`. |
| `GET`  | `/api/shapes?pair=<id>` | Polygon-only shapes for a pair. |
| `GET`  | `/api/crop/<pair_id>/<int:idx>` | Crop image for one training card. |
| `PATCH`/`PUT`/`DELETE` | `/api/images/<pair_id>` | Manage a set (DB-backed). |
| `POST` | `/api/iou` | Score one annotation (intersection ÷ union). |

Registry endpoints read/write the `annotation_set` table. The startup path
auto-creates the schema and runs a one-time idempotent import of
`data/manifest.json` into the registry (`kind='raw'`, `created_by='legacy'`).

### Comparison endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/api/image/<hash>` | Downscaled **overview** PNG (long side ≤ 2000 px, LANCZOS), cached. Frontend derives display scale from natural vs logical dimensions. |
| `GET`  | `/api/image/<hash>/crop?x=&y=&w=&h=` | Full-resolution PNG **crop** for pile zoom. |
| `POST` | `/api/compare` | Seed a comparison session (see §4.2). |

### Merge persistence endpoints

The comparison-session document (§4.2) is stored server-side in the `merge`
table; the client keeps only the merge ID in
`localStorage['lesion-compare-id']`.

| Method | Path | Purpose |
|---|---|---|
| `POST`   | `/api/merges` | Create a merge row from a seeded session; returns its `id`. |
| `GET`    | `/api/merges/<id>` | Read the stored merge doc (used on resume). |
| `PATCH`  | `/api/merges/<id>` | Update the stored doc (fire-and-forget autosave). |
| `POST`   | `/api/merges/<id>/save` | Save the merge as a `merged` `annotation_set`. Idempotent (re-save returns the existing set); display name auto-generated from source set names; links `merge.set_id`. |
| `DELETE` | `/api/merges/<id>` | Delete the merge draft. The saved `annotation_set`, if any, survives. |

### Analyze endpoint

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/analyze/<set_id>` | Footprint k-of-N agreement geometry for a `merged` set (see §5). Rejects `raw` sets (400); `reannotated` returns 501 until the consensus tool ships. |

`/api/compare` pools all polygons from the selected sets, runs a broad-phase
bbox-overlap check then a Shapely narrow-phase intersection, builds union-find
connected components, and returns the components as initial pile groupings
**plus the intersection edges**. The edges are kept client-side and used for the
connected-component check during splitting (§4.5); the graph itself is otherwise
discarded after seeding.

**Implementation note:** `img.load()` is called immediately after
`Image.open()` in `_get_image` to force eager pixel decode and avoid lazy-seek
issues with TIFF files under concurrent requests.

---

## 3. Training Tool

### Canvas

- Polygon drawing on an HTML5 canvas with pan/zoom; canvas coordinates map back
  to original image pixels (`canvasToOriginal` / `originalToCanvas`).
- **labelme-style closing**: click within the snap radius (~14 px) of the first
  vertex to close; a gold snap ring gives feedback.
- **Undo** (button and Ctrl+Z) removes the last vertex; undo after closing
  re-opens the polygon.
- Edges + a preview line are shown while drawing; fill appears only after
  closing.
- **Reveal phase**: clicking the canvas cycles overlays — `full` (fill +
  outline) → `none` (image only) → `outline` — *independently* for the
  ground-truth polygon and the user polygon. Resets to `full` on each new card.

### Scoring & modes

- **Polygon mode**: IoU as a percentage; tooltip shows raw intersection/union
  areas.
- **Label mode**: classification correct/incorrect.
- **Both mode**: polygon and label scores tracked separately.
- Configurable cards-per-session slider (1 – total available).
- Mode checkboxes must be explicitly selected (no default), to avoid accidental
  wrong-mode starts.

### Session flow

- Card selection: lowest cumulative score first, random tie-break; a
  just-answered card is immediately eligible again.
- **Suspend** removes a card from rotation; resumable from the progress modal.
- **Redo** allows an immediate retry without waiting for rotation.
- **Progress bar**: tried / suspended / total, colour-coded, with a live average
  accuracy. Clicking the tried or suspended counts opens a modal listing those
  cards with per-card retry/suspend actions and an Attempted/Suspended tab strip.
- Session persisted to `localStorage` (`SESSION_KEY = 'lesion-trainer'`) with a
  `version` field and migration logic (v1/unversioned → v2 adds `pairId`).

---

## 4. Comparison Tool

Three annotators independently annotate the same leaf image. The comparison tool
pools all annotations, groups them into distinct lesions, and helps the team
agree on a ground truth.

**Terminology.** "Training set" was renamed **"annotation set"** throughout
user-facing copy (code identifiers such as `pairId` unchanged). The `<h1>Lesion
Annotation Trainer</h1>` product title was intentionally left unchanged.

A **pile** is a *dog-pile* — all overlapping annotations of one distinct lesion,
pooled across **all** annotators (a pile is **not** per-annotator). Connected
components of the collision graph seed the initial piles. **Layers** model nested
lesions (a small lesion sitting on top of a larger one).

```
Layer   (visibility, collapse, reorder, delete-when-empty)
  └─ Pile   (visibility, collapse, conflict flag, per-pile randomised per-annotator colours)
       └─ Annotation   (stable global number, per-annotation overlay cycle)
```

### 4.1 Setup & persistence

- Reached from the **home screen** (Merge Sets tile). Training entry is a
  separate tile — `enterTrainingMode()` does the `pairs[0]` pre-select and
  `/api/shapes` fetch — so choosing Merge never pays for a training-only shapes
  fetch.
- Comparison setup: single-select image list (**one image per session**), per-set
  include toggles (all checked by default), Continue.
- On Continue: `POST /api/compare` seeds the session; the full doc is stored
  server-side in the `merge` table and only the merge ID kept in
  `localStorage['lesion-compare-id']`.
- **Set count label**: annotation set pickers (training config, manage screen,
  comparison setup) show "N shapes" for raw/reannotated sets and "N piles" for
  merged sets. Merged sets are disabled in the training config picker (they have
  no labelme JSON on disk).
- **Replace restriction**: the ↻ replace-files button is hidden for merged sets
  in the Manage Sets screen; `PUT /api/images/<id>` returns 400 for merged sets.
  (Merged sets have no image/JSON to replace — they are derived from the merge
  table.)
- Resume fork screen shows a session summary and a **Delete saved comparison**
  option. The saved `phase` (`grouping` or `final`) is restored and the correct
  page shown immediately.
- `readCompareSession` validates that the saved image hash and at least one set
  ID still exist in the manifest before trusting saved data.

### 4.2 Persisted session model (`compareSession`)

```jsonc
{
  "version": 1,
  "imageHash": "20a85ffa…",
  "includedSetIds": ["legacy", "ed0b8a1a-…"],
  "phase": "grouping" | "final",
  "blind": true,                       // grouping-page blind flag
  "finalBlind": true,                  // Compare-Lesions-page blind flag (independent)
  "globalColors": { "legacy": "#e74c3c", "ed0b8a1a-…": "#3498db" },
  "edges": [["a0","a7"], ["a1","a4"]], // intersection edges, for split connectivity
  "annotations": [
    { "id": "a0", "num": 1, "setId": "legacy",
      "points": [[x,y], …], "bbox": [x0,y0,x1,y1],
      "overlay": "outline" }           // per-annotation: outline | full | none
  ],
  "layers": [
    { "id": "L1", "name": "Layer 1", "collapsed": false, "visible": true,
      "piles": ["P1", "P2"] }
  ],
  "piles": {
    "P1": {
      "annotationIds": ["a0","a7","a12"],
      "collapsed": false,              // default !flagged (conflict piles expanded)
      "visible": true,
      "flagged": true,
      "showBbox": false,               // 3rd visibility state
      "colors": { "legacy": "#e74c3c", "ed0b8a1a-…": "#3498db" }
    }
  }
}
```

### 4.3 Canvas viewer (`compare_canvas.js`)

- Separate module from the trainer; **world coordinates = original image
  pixels**.
- **Overview mode**: renders the downscaled full image; all *visible*
  annotations drawn in layer → pile → annotation order.
- **Focus mode**: renders a full-resolution crop of the focused pile's bbox
  (+10 % padding); only the focused pile's annotations drawn.
- Pan (drag), wheel zoom. Initial framing = union bbox of all annotations
  (+10 % padding).
- **HiDPI**: canvas buffer dimensions multiplied by `window.devicePixelRatio`;
  pan deltas compensated by DPR.
- `imageSmoothingEnabled = false` in focus mode (pixel-accurate); `true` +
  `'high'` quality in overview.
- **Click-to-highlight**: ray-cast point-in-polygon hit test; shift/ctrl/plain
  click all work in both modes. Clicking an annotation whose pile is collapsed
  auto-expands that pile in the sidebar.

### 4.4 Group Distinct Lesions page

**Sidebar tree** — re-rendered on every mutation:
- **Layer row**: collapse caret, name, eye toggle (2-state), ↑/↓ reorder, ✕
  delete (disabled unless empty).
- **Pile row**: collapse caret, `Pile N · M annotations` label, 3-state
  visibility button, conflict `!` badge, 🔍 zoom button, ↑/↓ reorder.
- **Annotation row**: colour swatch (click cycles overlay), stable numeric
  label, row click = select/highlight.
- Sidebar auto-scrolls to keep the focused pile / most-recently-clicked
  annotation in view.

**3-state pile visibility** — the pile eye button cycles **visible (no bbox) →
hidden → visible with bounding box**. Layer rows keep the original 2-state
toggle.

**Blind mode** (`session.blind`, default on):
- On: each pile gets its own randomised annotator→colour mapping; identity is
  unrecognisable across piles.
- Off: fixed global palette (`globalColors`) — same annotator, same colour
  everywhere; a colour-key overlay appears top-right of the viewer.

**Per-annotation overlay** — swatch click cycles `outline → full → none`,
default `outline`, persisted per annotation.

**Conflict detection & resolution**:
- A pile is **flagged** if annotation counts are not equal across all included
  sets (an absent set counts as 0).
- A conflict is **trivial / "missing-only"** if every *present* annotator
  contributed the same count (the only disagreement is an absent annotator).
- The `!` badge toggles `pile.flagged` manually at any time.
- **"Done Grouping Distinct Lesions"** is disabled until every `pile.flagged`
  is false.
- Header stats line shows live pile count and conflict count.

**Filter bar** (three controls):

| Control | Behaviour |
|---|---|
| Hide resolved | Hides `flagged = false` piles from sidebar and canvas (does not change `pile.visible`). |
| Hide missing-only | Hides trivially-conflicting piles. |
| Auto-resolve missing | Marks all existing trivial conflicts resolved and keeps auto-resolving any new trivial pile from a split; mutually exclusive with Hide missing-only. |

### 4.5 Zoom / focus & split

- 🔍 loads a full-res crop centred on the pile bbox (+10 % padding); other piles
  dimmed in sidebar and hidden in viewer. ↩ restores overview and clears
  selection.
- **Split** (focus mode only): a "Split Off" button appears below the annotation
  list. Disabled unless the selected annotations form a **single connected
  component** (client-side union-find over the server-returned `edges`); hint
  text explains why when disabled.
- A **layer picker** chooses the destination layer (defaults to the pile's
  current layer; "New Layer…" creates one on the fly). UI order: layer picker
  first, then Split Off.
- After split: selected annotations become a new pile in the target layer;
  remaining annotations are re-checked for connectivity and may shard into
  further piles; focus moves to the new pile; bbox reframes. Auto-resolve (if on)
  is applied to the new pile **and** all remaining components including the
  original.

**Selection model** (`_selection`, a `Set` of annotation IDs, shared across
modes):
- Plain click: exclusive select (click again to deselect).
- Ctrl/Meta click: toggle one.
- Shift click (focus mode only): range select within the pile's list.
- Selection persists across zoom in/out; filtered to pile membership before
  split.

### 4.6 Compare Lesions page (final)

Reached via "Done Grouping Distinct Lesions"; sets `phase = 'final'`.

| Element | Grouping page | Compare Lesions page |
|---|---|---|
| Page title | "Group Distinct Lesions" | "Compare Lesions" |
| Pile labels | "Pile N · M annotations" | "Lesion N · M annotations" |
| Filter bar | shown | hidden |
| Conflict `!` badge | shown | hidden |
| Split controls | shown when zoomed | hidden |
| Zoom button | shown | shown (split row suppressed) |
| Blind mode | `session.blind` | `session.finalBlind` (independent) |
| Stats line | piles + conflicts | piles only |
| Bounding boxes | off by default | on by default |

**Blind mode here** (`finalBlind`, independent of the grouping flag):
- Blind (default): all annotations drawn uniform `rgba(74,158,255,0.22)` —
  overlaps blend darker, giving an agreement-density map; colour key hidden.
- Non-blind: each annotation drawn in its global annotator colour (fill +
  outline); colour key shown; sidebar swatches match.

**Bounding boxes**: drawn as dashed white rectangles over all annotations, from
the union of the pile's annotation bboxes. The 3-state visibility cycle is
available on both pages; all pile bboxes default on when entering this page.

**Navigation**: "← Back to Grouping" returns to the grouping page; focus state
and selection are cleared on both transitions.

**Save as set**: a 💾 button in the Compare Lesions header calls
`POST /api/merges/<id>/save`, persisting the merge as a `merged` annotation set
(idempotent; auto-named from the source sets). On success the set appears in the
pair list and in Manage Sets, and becomes selectable by the Analyze tool (§5).

---

## 5. Analyze Tool

Visualises **where annotators agree** across a `merged` set, without collapsing
disagreement. Reached from the Analyze home tile. (`reannotated` sets are an
intended input too, but the endpoint returns 501 for them until the consensus
tool ships.)

### 5.1 Footprint k-of-N agreement

For each pile (lesion), collapse each source to a **footprint** =
`unary_union` of all that source's polygons in the pile. With `m` = number of
sources that drew the pile, for each `k = 1..m` compute `area_k` = the region
covered by **≥ k** footprints (union over all `m-choose-k` intersections), and
`fraction = area_k / area_1`. `k=1` is the union (fraction 1.0); `k=m` is the
core intersection. The level-`k` rings are **nested**: `k=m ⊆ … ⊆ k=1`. All
geometry is computed server-side with Shapely.

### 5.2 `/api/analyze/<set_id>` response

```jsonc
{
  "displayName": "…", "imageHash": "…",
  "imageWidth": 0, "imageHeight": 0,
  "mTotal": 3,                       // distinct sources in the whole set
  "piles": [{
    "id": 1, "m": 2,                 // sources that drew THIS pile (≤ mTotal)
    "bbox": [x0,y0,x1,y1],           // world space (original pixels)
    "sourceRings": [{ "sourceId": "…", "rings": [[[x,y],…]] }],
    "agreementByK": {                // string keys "1".."m"
      "1": { "fraction": 1.0, "rings": [[[x,y],…]] },
      "2": { "fraction": 0.6, "rings": [[[x,y],…]] }
    }
  }]
}
```

JSON integer keys come back as strings; the frontend looks up with `String(k)`.

### 5.3 Viewer (SolidJS — `webapp/frontend/src/analyze/`)

Originally `analyze.js`; migrated to typed **SolidJS** (the framework pilot, see
[`Analyze SolidJS Migration.md`](./Analyze%20SolidJS%20Migration.md)). Pure logic
(`lib/agreement`, `geometry`, `draw`) is unit-tested under Vitest; the canvas is a
vanilla leaf driven by a Solid store. Behavior below is unchanged by the migration.

Set picker (filtered to `merged`/`reannotated`), then a pan/zoom canvas with a
control sidebar. The viewer went **beyond the original single-slider plan** —
the as-built behavior is:

- **Two threshold modes**, a toggle:
  - **Relative** — the planned percentage control; the slider is 0–100% and maps
    per pile to `k = max(1, ceil(pct/100 · pile.m))`.
  - **Absolute** — the slider is a literal count `0..mTotal`, same denominator
    for every pile. **Default mode**, default value `mTotal` (all-agree).
- **Min annotators** slider (`k`) — hides piles drawn by fewer than `k` sources.
- **Overlap level** slider — the agreement threshold above; drives which nested
  ring is drawn per pile. A two-column **k-breakdown** beside it shows the
  per-level bars.
- **Min IoU** slider — hides piles whose agreement fraction (at the chosen
  overlap level) falls below the cutoff ("show me only the contested lesions").
- **Blind** toggle (hide per-source colors), **Bbox** toggle (dashed per-pile
  boxes), a **color** picker, and an **opacity** popup.
- Clicking a pile selects it: per-source outlines in per-annotator colors, plus a
  sidebar **pile detail** (the k-breakdown bar chart) and, on clicking a bar, a
  **k-detail** panel with intersection/union pixel areas. `analyzeDetailK` tracks
  the sidebar selection independently of the main overlap slider.

### 5.4 Delta-alpha rendering (preserve exactly)

Agreement depth is drawn by stacking the nested rings with per-ring alpha so the
cumulative opacity after ring `ki` equals `ki/N · T` (`T` = chosen opacity,
`N = mTotal` in absolute mode / `pile.m` in relative mode):

```
step          = T / N
drawAlpha_ki  = step / (1 - (ki-1) · step)     for ki = 1 .. pile.m
```

Deeper-agreement regions appear more opaque, in the user's chosen color. This
relies on the rings being nested (each ring fully covers all lower-k rings).

### 5.5 Solid ↔ vanilla bridge (as-built)

The old undocumented globals (`analyze.js` reaching into `setup.js` / `app.js` /
`components.js`) are now an **explicit typed bridge** (`src/analyze/lib/bridge.ts`):
Solid reads the pair registry via `getAvailablePairs()` (← `window.availablePairs`),
the byline via `getUser()`/`setUser()`, and shares `buildIoUDetail` with the still-vanilla
trainer. The full nav-layer `window._*` contract is tabulated in HANDOFF.md.

Known issue (open, see HANDOFF "Analyze viewer — de-imperative"): the picker reads
`window.availablePairs` **non-reactively at setup**, so a direct navigation / refresh to
`/analyze` (before the global is populated) shows an empty list; arriving via Home works.
To be fixed by sourcing the list from a reactive store.

---

## 6. Invariants (test targets)

These should hold at all times and are the natural assertions for a future test
suite. Grouped by concern.

### Structural

- **I1** Every annotation belongs to **exactly one** pile — no orphans, no
  annotation in two piles.
- **I2** Every pile belongs to **exactly one** layer; every ID in a layer's
  `piles[]` resolves to an existing pile, and every pile is referenced by exactly
  one layer.
- **I3** Every annotation's `setId` is in `includedSetIds`.
- **I4** `annotation.num` is unique across the session and **stable** across
  splits, moves, and reloads.
- **I5** Every entry in `edges` references two annotation IDs that exist in the
  session.
- **I6** A pile's `colors` map covers every `setId` that appears among that
  pile's annotations.

### Conflict

- **I7** *Seeding rule:* a pile is flagged iff per-set annotation counts (absent
  set = 0) are not all equal. Note this is enforced **at seeding and after
  splits**, not as a continuously maintained invariant — the `!` badge lets the
  user override `flagged` manually afterward.
- **I8** A pile is "missing-only" (trivial) iff every *present* set contributed
  the same count.
- **I9** "Done Grouping" is enabled **iff** every pile has `flagged === false`.
- **I10** "Auto-resolve missing" and "Hide missing-only" are never both active.

### Split

- **I11** Split is offered only in focus mode and only when the current selection
  forms a single connected component under `edges`.
- **I12** Annotation count is **conserved** across any split: no annotation is
  created, lost, or duplicated.
- **I13** After a split, every resulting pile (new, original remainder, and any
  further shards) is internally connected under `edges`.

### State & persistence

- **I14** 3-state pile visibility cycles exactly `visible(no bbox) → hidden →
  visible+bbox → …`.
- **I15** `session.blind` and `session.finalBlind` are independent — changing one
  never mutates the other.
- **I16** A session restored from `localStorage` only loads if its `imageHash`
  and ≥1 of its `includedSetIds` still exist in the manifest; otherwise it is
  rejected cleanly.
- **I17** `phase ∈ {grouping, final}` round-trips through save/restore.

### Geometry / rendering

- **I18** World coordinates equal original image pixels in both overview and
  focus mode; a point clicked maps to the same world coordinate regardless of
  zoom/pan/DPR.
- **I19** A pile's drawn bounding box equals the union of its annotations'
  bboxes (+ padding only where specified).

---

## 7. Known future work

- **Consensus builder (re-annotation)** — the unbuilt collaborative tool; see
  [`Consensus Builder Plan.md`](./Consensus%20Builder%20Plan.md). (The footprint
  k-of-N agreement metric it depends on is already built in the Analyze tool, §5.)
- **New annotator** — labelme replacement (projects/tiles/batches); see
  [`Annotator Plan.md`](./Annotator%20Plan.md).
- **Analyze viewer routing** — the analyze viewer still launches via an imperative
  overlay rather than its own route, so browser Back doesn't dismiss it; pair with the
  reactive-picker fix in §5.5. Small, next on the frontend list (see HANDOFF.md).

Shipped since the original spec: the **frontend framework migration** — the Analyze
tool (§5.3) and the whole **nav/setup layer** are now SolidJS + TypeScript + Vite with
client-side routing (§1). The Analyze SolidJS migration and the Nav Layer migration +
polish are done; see their plan docs and HANDOFF.md.
- **Layer rename** — names default to "Layer N"; renaming deferred.
- **Labels** — annotation label fields exist in the data but are ignored by the
  comparison tool.

## 8. Bug fixes — Analyze viewer (2026-06-23)

Three silent regressions introduced by the `b003515` Analyze viewer commit; all fixed
and documented in `Bug Diagnosis — Analyze Viewer Regression.md`.

**Bug 1 — CDF bars stale after pile switch.** `PileDetailPanel.tsx`: derived values
inside a `<For>` render callback were plain consts (computed once). Fixed: wrap as
getter functions (`const entry = () => …`) so JSX tracks them reactively.

**Bug 2 — Sidebar sliders frozen / crashing.** `SliderField.tsx`: passing a `ref` to
Kobalte's `<SliderTrack>` bypasses its internal track-ref registration (a Kobalte
bug). Fixed: move `ref` to `<SliderRoot>` (which handles `ref` correctly); add
`pointer-events: none` to the fill so it doesn't steal pointer capture.

**Bug 3 — Opacity slider unstyled.** `AnalyzeHeader.tsx`: `class="range-input"` was a
bare string pointing at a global rule that was deleted in the CSS-modules refactor.
Fixed: add `.rangeInput` to `AnalyzeHeader.module.css`; use `class={styles.rangeInput}`.

## 9. Playwright smoke baseline (2026-06-24)

**Runner:** Playwright Test (`@playwright/test`, Chromium-only). Replaces the ad-hoc
`e2e/probe.mjs` Puppeteer script. `webServer` block auto-starts `uv run app.py` and
tears it down; `storageState` seeds `lesion-user` so the byline modal doesn't block.
`workers: 1` (Flask debug server; increase when switching to a production WSGI server).

**Data:** uses the local `data/` directory by default. `HT_DATA_DIR` env var (added to
`app.py` and `db.py`, 2026-06-24) overrides the data directory, enabling committed
fixture data for CI in P4. Run: `cd webapp/frontend && npm run smoke`.

**Coverage (`e2e/smoke/`):**
- `nav.spec.ts` — home tiles, Manage, Train, Merge screens: no JS errors, key controls
  visible, API-dependent content loads.
- `analyze.spec.ts` — analyze picker, analyze viewer: `#analyze-screen` un-hides after
  `fetchAnalyze()` resolves; computed-style assertion (`cursor: pointer`) on the
  SolidJS-rendered opacity slider proves the CSS module loaded (catches the Bug 3 class
  of regression — a deleted global class is silent without this check).

All 6 tests green as of commit `<this commit>`.
