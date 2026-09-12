# Deploying the ECEWS-SPEED TF Monitoring Dashboard

The app is one Docker web service (FastAPI serving the SPA + API) plus a Postgres
database. HTTPS is required — the login sends passwords, so never expose it over
plain HTTP.

> **Build context changed (12 Sep 2026).** The Dockerfile now builds the React
> app in a first stage, so `docker-compose` builds from the **repo root** with
> `dockerfile: backend/Dockerfile`. The hosted options below still use
> `backend/` as their root directory and therefore produce no React build —
> `main.py` mounts `/app` only if it exists, so the live dashboard at `/` is
> unaffected. When the React app replaces it, those root directories change to
> the repo root.

## Versions, and knowing which build is live

The sidebar footer carries the build under the line-list date — `v1.2 · a1b2c3d`
— and `/api/version` returns the same thing as JSON, unauthenticated. That is
what to read out when something looks wrong; "the dashboard" is not a build.

**Deploy locally with `backend\scripts\deploy.ps1`, not `docker compose up
--build`.** Both rebuild; only the script passes the commit into the image, so
without it the build line reads `unknown` — accurate, and useless at the moment
you need it. `deploy.ps1 -Check` says what is running now and whether the served
page matches your working tree.

An amber version with a `+` means the image was built from a working tree with
uncommitted changes. Fine while developing; it should never be what a state
team is looking at.

### What the live site shows, and where each part comes from

| Shown | Comes from | On a hosted deploy |
|---|---|---|
| `v1.2` | `backend/app/VERSION`, committed | Whatever that file says **at the commit the host built**. Push the release commit and the tag, and the site shows it. |
| `· a1b2c3d` | `GIT_COMMIT` build arg, else the platform's own variable | Render and Railway publish the commit themselves (`RENDER_GIT_COMMIT`, `RAILWAY_GIT_COMMIT_SHA`) and the app reads them, so this works with no configuration. |
| the `+` | whether the build had uncommitted changes | **Never appears.** A host builds from a clean clone, so there is nothing to be dirty. |

So a live site deployed from `main` at tag `v1.2` shows **`v1.2 · a1b2c3d`**, with
no `+`. Locally you will usually see the `+`, because you are usually mid-edit —
that is the difference you are looking at, not a fault.

**Fly.io is the exception:** `fly deploy` publishes no commit variable, so set
one yourself or the line reads `v1.2` with no commit:

```bash
fly deploy --build-arg GIT_COMMIT=$(git rev-parse --short=7 HEAD)
```

**Releasing to a live site is two pushes**, and a tag that never leaves your
machine is not a release anyone else can check out:

```bash
git push && git push --tags
```

### Cutting a release

```powershell
python backend\scripts\bump_version.py minor    # 1.0 -> 1.1
python backend\scripts\bump_version.py major    # 1.4 -> 2.0
git push && git push --tags
```

It refuses to tag a dirty tree, writes `backend/app/VERSION`, commits, and
creates the annotated tag. Which of the two to use:

| | When |
|---|---|
| **minor** | Anything the team will notice but nothing they must relearn — a new panel, a fixed chart, a new export column. Most releases. |
| **major** | The meaning of a number changed, or a workflow did — a new indicator definition, a different cohort rule, a page that moves or disappears. **If a state team's briefing note would now be wrong, it is major.** |

The tags are the record: `git tag` lists the releases, `git log v1.1..v1.2`
says what changed between two of them.

## Security checklist (do this first — the app is public once deployed)
- [ ] **Strong `JWT_SECRET`** — a long random string. On Render the blueprint
      generates one automatically.
- [ ] **Change `ADMIN_PASSWORD`** from the local `blindalley`.
- [ ] **Change `VIEWER_PASSWORD`** from the default `viewer1234`.
- [ ] **HTTPS on** — automatic on Render/Railway/Fly; mandatory.
- [ ] Never commit `.env` (already in `.gitignore`).

## Option A — Render (recommended, uses `render.yaml`)
1. Push this folder to a GitHub/GitLab repo.
2. Render dashboard → **New → Blueprint** → pick the repo. It reads `render.yaml`
   and creates the web service + `ecews-db` Postgres.
3. When prompted, set **ADMIN_PASSWORD** and **VIEWER_PASSWORD** (JWT_SECRET and
   DATABASE_URL are handled automatically).
4. First boot seeds `admin@ecews.org` and `viewer@ecews.org` and runs the schema.
5. Open the URL, sign in as admin, go to **Admin → Upload** the Parquet zip
   (line-list date 2026-07-11) — the DB starts empty until you upload.
6. Add teammates on **Admin → Users & access**.

Notes: Render `free` web spins down after ~15 min idle (first hit is slow); use
`starter` to stay warm. Free Postgres expires after 90 days.

## Option B — Railway (step by step)

The Dockerfile lives in `backend/`, so Railway must build with **`backend/` as the
service root** (dashboard) or by running `railway up` from inside `backend/` (CLI).

**Dashboard (most reliable):**
1. Push this repo to GitHub (private).
2. railway.app → **New Project → Deploy from GitHub repo** → pick it.
3. On the created service → **Settings → Root Directory = `backend`** (so it builds
   `backend/Dockerfile`, not the repo root).
4. Project → **New → Database → PostgreSQL**.
5. Web service → **Variables** → add:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`  (reference to the DB)
   - `JWT_SECRET` = a long random string
   - `ADMIN_PASSWORD` = strong value
   - `VIEWER_PASSWORD` = strong value
   (`PORT` is injected automatically; the Dockerfile binds to it.)
6. Web service → **Settings → Networking → Generate Domain** (HTTPS).
7. Open the domain → sign in as admin → **Admin → Upload** the Parquet zip
   (line-list date 2026-07-11). The DB is empty until you upload.
8. Add teammates on **Admin → Users & access**.

**CLI shortcut** (if `railway` is on PATH; install via `npm i -g @railway/cli`):
`railway login` → `railway init` (from repo root) → `railway add --database postgres`
→ `cd backend && railway up` → set the four variables (dashboard is easiest for the
`${{Postgres.DATABASE_URL}}` reference) → `railway domain`.

## Option C — Fly.io
- `fly launch` in `backend/` (uses the Dockerfile), `fly postgres create` then
  `fly postgres attach` to set `DATABASE_URL`, and
  `fly secrets set JWT_SECRET=… ADMIN_PASSWORD=… VIEWER_PASSWORD=…`.

## Converting the workbook (once, before upload)
`docker run --rm -v ${PWD}:/work ecews_tf_monitor-api \
  python /work/backend/scripts/to_parquet.py "/work/<file>.xlsx"`
