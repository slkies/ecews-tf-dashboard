# Deploying the ECEWS-SPEED TF Monitoring Dashboard

The app is one Docker web service (FastAPI serving the SPA + API) plus a Postgres
database. HTTPS is required — the login sends passwords, so never expose it over
plain HTTP.

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
