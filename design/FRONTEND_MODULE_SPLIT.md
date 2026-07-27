# Frontend module split — proposal

**Status:** proposal, for discussion with the HI team
**Author:** Data Analytics Lead, ECEWS/SPEED
**Applies to:** `backend/static/index.html`

## Why

`index.html` is **2,682 lines** in a single file: 547 lines of CSS, 1,557 of
JavaScript across 42 functions, and the markup for eleven pages. The external
code review named this the codebase's main weakness, and it costs us three
concrete things:

1. **No reuse.** A KPI card is assembled by string concatenation in several
   places; changing its markup means finding every one of them.
2. **No frontend tests.** The backend has 120. The frontend has none, because a
   function that returns an HTML string glued into `innerHTML` is impractical to
   test in isolation. This is not theoretical — it is why a broken
   password-change shipped: the request was missing a header, and nothing
   caught it.
3. **One file, one editor.** Two people working on it will conflict constantly.

## What this proposal is *not*

This is **not** a React migration. It uses **native ES modules**, which every
current browser supports directly. That means:

- **no build step** — no npm, no bundler, no `node_modules`
- **no change to deployment** — still `docker compose up`, still one static
  directory served by FastAPI
- **no new dependencies** — the count stays at zero for the frontend
- **the no-external-requests property is preserved** — everything is still
  served from our own origin, which matters for the institutional firewall and
  is stated in the technical dossier

If we later decide on React, a modular codebase is far easier to port than a
single 2,682-line file. This step is useful either way, which is the main
argument for doing it first.

---

## Proposed layout

```
backend/static/
  index.html               markup only — shell + the eleven page sections   (~700)
  vendor/                  unchanged: Chart.js, self-hosted IBM Plex
  css/
    tokens.css             :root custom properties, light + dark             (~60)
    shell.css              rail, header, filters, drawer, responsive         (~150)
    components.css         .stat .panel .plan tables .notice .tag .btn       (~200)
    pages.css              cascade bars, deep-dive grid, map, forest plot    (~140)
  js/
    main.js                entry point: boot, refresh, event wiring          (~110)
    core/
      state.js             shared mutable state (token, user, charts)         (~20)
      api.js               api(), qs(), download()                            (~60)
      format.js            fmt, pc, esc, fmtMonYY, periodLabel, lighten       (~40)
      theme.js             light/dark palettes, applyChartPalette, toggle     (~50)
      chart.js             chart() factory + shared axis presets              (~40)
    ui/
      shell.js             switchTo, rail open/close/collapse                 (~70)
      auth.js              signIn, signOut, password change                   (~60)
      notices.js           notices() + the data-notices drawer                (~45)
      tables.js            the sortable-table click handler                   (~40)
    pages/
      overview.js          overview(), overviewTime()                        (~270)
      cascade.js           cascade(), loadClients()                           (~95)
      deep.js              deep(), dpRender(), ddRender(), drawLgaMap()      (~380)
      dtc.js               dtcView()                                          (~80)
      time.js              timeView()                                         (~85)
      plans.js             plansView() + PLAN_WHY, PCOL                       (~65)
      advanced.js          advanced()                                         (~60)
      dq.js                dqView(), banners()                                (~45)
      admin.js             uploads, users, usage, feedback                   (~140)
```

Largest file becomes `deep.js` at ~380 lines — reviewable in one sitting,
against 2,682 today.

## The one genuine design decision: shared state

Five values are currently module-level globals mutated from several places:

```js
let TOKEN = localStorage.getItem('tf_token'), ME = null, CH = {}, LAST = null;
const C = Object.assign({}, C_LIGHT);          // active chart palette
```

An exported `let` in an ES module is **read-only to importers**, so these
cannot simply be exported as-is. The straightforward fix is a single mutable
state object:

```js
// core/state.js
export const S = {
  token: localStorage.getItem('tf_token'),
  me:    null,
  charts:{},          // was CH — the Chart.js registry, keyed by canvas id
  last:  null,        // was LAST — the current drill-down selection
};
```

Callers then use `S.token`, `S.charts`, and so on. This is a mechanical
change, but it is the part to get right, because it touches every module.

`C` (the active chart palette) belongs in `theme.js` and is read through a
getter so a theme switch is picked up without every module re-importing.

## Migration order

Each step is independently verifiable and independently revertible. Nothing
here is a big-bang rewrite.

| Step | Work | Risk |
|---|---|---|
| 1 | Extract the four CSS files, link them from `index.html` | **Very low** — no JS touched; the page either styles correctly or it does not |
| 2 | Extract leaf helpers with no dependencies: `format.js`, `theme.js`, `chart.js` | Low |
| 3 | Extract `state.js` and `api.js`; convert the globals to `S.*` | **Highest** — touches everything, do it in one focused pass |
| 4 | Extract the nine page modules, **one per commit**, verifying each page in the browser | Low, and isolated per page |
| 5 | Extract `ui/` and reduce `main.js` to boot and wiring | Low |

Steps 1 and 4 are the bulk of the benefit and carry the least risk. Step 3 is
the one to schedule deliberately.

## What this fixes, and what it does not

**Fixes**

- Files are small enough to review, and two people can work without conflicts.
- Pure functions become unit-testable: the sort comparator, the plan-letter
  extraction, `fmt`/`pc`/`esc`, `periodLabel`. These can run under any JS test
  runner, or in CI with no browser at all.
- Changing a shared component means editing one file.

**Does not fix**

- It will not prevent logic bugs. Nothing in this proposal would have caught
  the missing request header, the grid-overflow issues, or the plan-routing
  errors — those were logic, CSS and data problems.
- It is not a design change. The interface behaves identically afterwards.

## Trade-offs, stated honestly

- **More HTTP requests** — around twenty small files instead of one. Over
  HTTP/2 from the same origin this is not measurable at our size. If it ever
  matters, a trivial concatenation step can be added without changing the
  source layout.
- **No minification.** The served payload grows slightly. At 160 KB of
  hand-written source this is not a concern.
- **Module scripts are deferred.** Execution moves to after HTML parsing, so
  any code assuming the old inline-at-end-of-body timing needs checking. In
  practice this affects only `main.js`.
- **It is refactoring, not features.** It buys maintainability, not
  capability. Worth being explicit about that when scheduling it.

## Recommended sequencing

1. Let ECEWS close the hosting review against the architecture already
   documented.
2. Re-upload the workbook so the deployed site shows the A–H treatment plans.
3. Then do steps 1 and 4 above — the cheap, high-value part.
4. Revisit React only if the HI team commits to co-maintaining the frontend.
   If they do, this modular layout is the starting point for that port, not
   wasted work.
