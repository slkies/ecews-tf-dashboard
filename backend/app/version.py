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

    # Baked at image build (docker-compose passes these as build args). Present
    # in a real deployment; absent when running from a checkout.
    commit = os.getenv("GIT_COMMIT") or ""
    dirty_env = os.getenv("GIT_DIRTY")

    if not commit:
        commit = _git("rev-parse", "--short=7", "HEAD") or _UNKNOWN

    if dirty_env is not None:
        dirty = dirty_env.strip().lower() in ("1", "true", "yes")
    else:
        status = _git("status", "--porcelain")
        # None means git could not be consulted - unknown, not clean. Saying
        # "clean" on no evidence is the one answer that could mislead someone
        # into trusting a build they should not.
        dirty = bool(status) if status is not None else False

    return {
        "version": version,
        "commit": commit,
        "dirty": dirty,
        # What a person should read out when reporting a problem. The commit is
        # what actually identifies the build; the version is what they can say
        # out loud.
        "label": f"v{version}" + ("+" if dirty else ""),
    }
