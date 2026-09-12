"""How the build line resolves, especially where we cannot watch it.

Local Docker is easy to check by looking. A Render or Railway deployment is
not, and that is exactly the environment where "which build is this?" gets
asked - so the cases that matter most here are the ones nobody can eyeball.
"""
from __future__ import annotations

import pytest

from app import version as V


@pytest.fixture(autouse=True)
def _clear_cache():
    """build_info() is cached for the process; these tests change its inputs."""
    V.build_info.cache_clear()
    yield
    V.build_info.cache_clear()


@pytest.fixture
def no_git(monkeypatch):
    """An image: no git binary, no .git directory."""
    monkeypatch.setattr(V, "_git", lambda *a: None)


def _clear_env(monkeypatch):
    for name in ("GIT_COMMIT", "GIT_DIRTY", *V._HOST_COMMIT_VARS):
        monkeypatch.delenv(name, raising=False)


def test_our_build_arg_wins(monkeypatch, no_git):
    _clear_env(monkeypatch)
    monkeypatch.setenv("GIT_COMMIT", "abc1234")
    monkeypatch.setenv("GIT_DIRTY", "false")
    info = V.build_info()
    assert info["commit"] == "abc1234"
    assert info["dirty"] is False
    assert info["label"] == f"v{info['version']}"


@pytest.mark.parametrize("var", V._HOST_COMMIT_VARS)
def test_a_hosted_deploy_reports_its_own_commit(monkeypatch, no_git, var):
    """Without this the build line reads 'unknown' on every hosted deploy -
    the platforms build from the repo and never see our build arg."""
    _clear_env(monkeypatch)
    monkeypatch.setenv(var, "0123456789abcdef0123456789abcdef01234567")
    info = V.build_info()
    assert info["commit"] == "0123456"        # shortened from the full sha
    assert info["dirty"] is False


def test_a_clean_hosted_build_carries_no_plus(monkeypatch, no_git):
    """The '+' means 'built from uncommitted changes'. A host clones clean, so
    it must never appear in production - it would tell the team a released
    build is unreleasable."""
    _clear_env(monkeypatch)
    monkeypatch.setenv("RENDER_GIT_COMMIT", "deadbee" * 5 + "fbee")
    assert "+" not in V.build_info()["label"]


def test_a_dirty_local_build_says_so(monkeypatch, no_git):
    _clear_env(monkeypatch)
    monkeypatch.setenv("GIT_COMMIT", "abc1234")
    monkeypatch.setenv("GIT_DIRTY", "true")
    info = V.build_info()
    assert info["dirty"] is True
    assert info["label"].endswith("+")


def test_nothing_at_all_is_unknown_not_a_crash(monkeypatch, no_git):
    _clear_env(monkeypatch)
    info = V.build_info()
    assert info["commit"] == "unknown"
    assert info["version"]          # still reads app/VERSION


def test_version_file_is_major_minor():
    """bump_version.py and the whole scheme assume exactly two parts."""
    raw = V._read_version_file()
    major, _, minor = raw.partition(".")
    assert major.isdigit() and minor.isdigit(), raw
