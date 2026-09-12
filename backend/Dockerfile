# Two stages. React needs a build step - that is the cost of the rewrite, and
# the honest way to pay it is to run the build here rather than commit compiled
# assets to git.
#
# The build context is the REPO ROOT (see docker-compose.yml), not backend/,
# because the frontend sources live outside backend/. The hosted deployments in
# DEPLOY.md still build with backend/ as their root; they simply produce no
# static_app, and main.py mounts /app only if it exists, so the live dashboard
# at / is unaffected either way.

# ── stage 1: build the React app ──────────────────────────────────────
FROM node:22-slim AS frontend
WORKDIR /build
# package.json and the lockfile first: this layer is cached unless the
# dependencies actually change, which is the slow part.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY frontend/ ./
RUN npm run build          # writes ../backend/static_app, i.e. /backend/static_app

# ── stage 2: the application image ────────────────────────────────────
FROM python:3.12-slim
WORKDIR /srv
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
COPY backend/requirements.txt .
RUN pip install -r requirements.txt
COPY backend/app ./app
COPY backend/static ./static

# The React build. Node is not in this image - only its output.
COPY --from=frontend /backend/static_app ./static_app

# Which commit this image is. There is no .git in the image and no git binary,
# so the value has to be passed in at build; app/version.py falls back to
# reading git directly when running from a checkout. Defaults keep a plain
# `docker build` working - it just cannot say which commit it is.
ARG GIT_COMMIT=unknown
ARG GIT_DIRTY=false
ENV GIT_COMMIT=${GIT_COMMIT} GIT_DIRTY=${GIT_DIRTY}

EXPOSE 8000
# Bind to $PORT when a host injects one (Render/Railway/Fly); default 8000 so
# the local docker-compose (8080->8000) keeps working unchanged.
CMD ["sh","-c","uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
