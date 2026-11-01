"""Select Review Runs and Memory Catalog entries for CI's postgres-packages job.

Read CHANGED_AREAS as the JSON array emitted by paths-filter and select affected
packages before matrix expansion, avoiding unrelated runners and databases.
GITHUB_EVENT_NAME=merge_group selects every package for the merge candidate.
Append the JSON matrix as the ``matrix`` step output to GITHUB_OUTPUT. An empty
selection is valid; the workflow skips the job when neither package changed.
"""

import json
import os
from pathlib import PurePosixPath

packages = [
    {
        "name": "Review Runs",
        "directory": "services/review-runs",
        "database": "sec_review_bot_test",
        "user": "sec_review_bot",
    },
    {
        "name": "Memory Catalog",
        "directory": "services/memory-catalog",
        "database": "memory_catalog_test",
        "user": "memory_catalog",
    },
]
changed = json.loads(os.environ["CHANGED_AREAS"])
selected = [
    package
    for package in packages
    if os.environ["GITHUB_EVENT_NAME"] == "merge_group"
    or PurePosixPath(package["directory"]).name in changed
]
with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
    output.write(f"matrix={json.dumps({'include': selected})}\n")
