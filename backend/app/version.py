"""What version is this, and which commit is it actually running?

A deploy that looks done and is not has cost this project more time than any
bug (see /api/version). Version answers a different question from `index_sha`:
the hash says *which file*, the version says *which release*, and only one of
those means anything to someone reporting a problem over the phone.

Three values, resolved in order of how much they can be trusted:

    version   1.2        from app/VERSION - committed, and tagged v1.2 in git
    commit    a1b2c3d    baked at image build, or read from git in development
    dirty     True       the working tree had uncommitted changes at build

`VERSION` is a file rather than a `git describe` call because the container has
no git and no .git directory - the image is built from a COPY of `app/` and
`static/`. Reading a file works identically in the container, in development,
and in CI, which a git call does not.
"""
from __future__ import annotations

import os
import subprocess
from functools import lru_cache
from pathlib import Path

_HERE = Path(__file__).parent
_VERSION_FILE = _HERE / "VERSION"
_UNKNOWN = "unknown"

# The commit, as each hosting platform publishes it. DEPLOY.md lists Render,
# Railway and Fly; the rest cost nothing to support and mean the build line
# works wherever this ends up. Fly has no equivalent - `fly deploy` passes
# nothing - so a Fly deployment needs GIT_COMMIT set as a secret, which
# DEPLOY.md says.
_HOST_COMMIT_VARS = (
    "RENDER_GIT_COMMIT",        # Render
    "RAILWAY_GIT_COMMIT_SHA",   # Railway
    "SOURCE_COMMIT",            # Docker Hub automated builds
    "HEROKU_SLUG_COMMIT",       # Heroku
    "VERCEL_GIT_COMMIT_SHA",    # Vercel
    "GITHUB_SHA",               # GitHub Actions, so CI matches production
)


def _read_version_file() -> str:
    try:
        v = _VERSION_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        return _UNKNOWN
    return v or _UNKNOWN


def _git(*args: str) -> str | None:
    """Run a git command in the repo, or return None if that is not possible.

    Development convenience only. In the container there is no .git and no git
    binary, so every call here fails and the baked build args are used instead
    - which is the intended path, not a fallback.
    """
    try:
        out = subprocess.run(("git", *args), cwd=_HERE, capture_output=True,
                             text=True, timeout=2, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip() if out.returncode == 0 else None


@lru_cache(maxsize=1)
def build_info() -> dict[str, object]:
    """Version, commit and cleanliness, cached for the process lifetime.

    Nothing here changes while the process runs: the file is baked into the
    image and the git state is fixed at build. Caching keeps /api/version from
    shelling out to git on every request in development.
    """
    version = _read_version_file()

    # Where the commit comes from, in order:
    #
    #   1. GIT_COMMIT   - our own build arg, set by scripts/deploy.ps1.
    #   2. The host's    - Render, Railway and the rest build straight from the
    #      own variable    repository and never see our build arg, so without
    #                      this a hosted deploy reports "unknown" and the build
    #                      line loses the only value that actually identifies
    #                      it. Each platform publishes the commit under its own
    #                      name, at runtime as well as at build.
    #   3. git itself   - development, running from a checkout.
    commit = os.getenv("GIT_COMMIT") or ""
    if not commit:
        for var in _HOST_COMMIT_VARS:
            if (v := os.getenv(var)):
                commit = v
                break
    if not commit:
        commit = _git("rev-parse", "--short=7", "HEAD") or _UNKNOWN
    # Hosts publish the full 40-character sha; ours is already short.
    commit = commit.strip()[:7] or _UNKNOWN

    dirty_env = os.getenv("GIT_DIRTY")
    if dirty_env is not None:
        dirty = dirty_env.strip().lower() in ("1", "true", "yes")
    else:
        # No env var and no git means this is neither our image nor a checkout
        # - a tarball, or a host that builds from a clean clone. Clean is the
        # accurate answer there: there is no working tree to be dirty.
        dirty = bool(_git("status", "--porcelain"))

    return {
        "version": version,
        "commit": commit,
        "dirty": dirty,
        # What a person should read out when reporting a problem. The commit is
        # what actually identifies the build; the version is what they can say
        # out loud.
        "label": f"v{version}" + ("+" if dirty else ""),
    }
