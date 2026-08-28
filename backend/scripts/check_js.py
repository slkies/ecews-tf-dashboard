"""Parse the dashboard's inline JavaScript and report syntax errors.

index.html is one file with the script inline, so nothing ever type-checked or
even PARSED it. A duplicate `const` shipped once and took the whole page with
it: a SyntaxError anywhere in a script block stops the entire block, so no
handler bound anywhere and the sign-in button silently did nothing. The page
still rendered, because the HTML and CSS were fine, which made it look like a
login fault rather than a broken script.

Brace counting does not catch that. A parser does.

    python check_js.py

Exits non-zero on a syntax error, so CI can gate on it.
"""
from __future__ import annotations

import re
import subprocess
import sys
import tempfile
from pathlib import Path

HTML = Path(__file__).resolve().parents[1] / "static" / "index.html"


def main() -> int:
    if not HTML.exists():
        print(f"  not found: {HTML}")
        return 1

    html = HTML.read_text(encoding="utf8")
    # Inline blocks only. A src= script is a vendored file with its own life.
    blocks = [(m.start(), m.group(1)) for m in
              re.finditer(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>",
                          html, re.S | re.I)]
    if not blocks:
        print("  no inline <script> found")
        return 1

    if not (node := _node()):
        print("  node is not installed - cannot parse. Install Node, or run "
              "this where it is available.")
        return 1

    bad = 0
    for offset, code in blocks:
        line0 = html[:offset].count("\n") + 1
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False,
                                         encoding="utf8") as fh:
            fh.write(code)
            tmp = Path(fh.name)
        try:
            r = subprocess.run([node, "--check", str(tmp)],
                               capture_output=True, text=True)
        finally:
            tmp.unlink(missing_ok=True)

        if r.returncode == 0:
            print(f"  OK    inline script at line {line0}: "
                  f"{len(code.splitlines()):,} lines parse cleanly")
            continue

        bad += 1
        print(f"  FAIL  inline script starting at line {line0}")
        # node reports a line number within the extracted block; translate it
        # back to the line in index.html so the message is actionable.
        for ln in r.stderr.splitlines():
            m = re.search(r"^.*?:(\d+)$", ln.strip())
            if m:
                print(f"        {ln.strip()}   -> index.html line "
                      f"{line0 + int(m.group(1)) - 1}")
            elif ln.strip():
                print(f"        {ln.strip()}")
    return 1 if bad else 0


def _node() -> str | None:
    for cand in ("node", "node.exe"):
        try:
            subprocess.run([cand, "--version"], capture_output=True, check=True)
            return cand
        except (OSError, subprocess.CalledProcessError):
            continue
    return None


if __name__ == "__main__":
    sys.exit(main())
