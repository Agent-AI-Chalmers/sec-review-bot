"""Canonical versions of cross-package contracts consumed by agents.

This module deliberately has no imports. Build hooks can therefore read the
same version constants as runtime code without importing runtime dependencies.
Each constant names its contract family explicitly; the versions may evolve
independently.
"""

EXECUTION_API_VERSION = "v1"
EXECUTION_WORKFLOW_VERSION = "v1"
MEMORY_CATALOG_API_VERSION = "v1"
TAR_ZSTD_ENVELOPE_VERSION = "v1"
MEMORY_TREE_ARTIFACT_VERSION = "v1"
RUN_DIAGNOSTIC_ARTIFACT_VERSION = "v1"

__all__ = [
    "EXECUTION_API_VERSION",
    "EXECUTION_WORKFLOW_VERSION",
    "MEMORY_CATALOG_API_VERSION",
    "MEMORY_TREE_ARTIFACT_VERSION",
    "RUN_DIAGNOSTIC_ARTIFACT_VERSION",
    "TAR_ZSTD_ENVELOPE_VERSION",
]
