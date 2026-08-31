import sys
from pathlib import Path

AGENTS_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = AGENTS_ROOT.parent

for path in (AGENTS_ROOT / "src", AGENTS_ROOT, REPO_ROOT):
    path_str = str(path)
    if path_str not in sys.path:
        sys.path.insert(0, path_str)
