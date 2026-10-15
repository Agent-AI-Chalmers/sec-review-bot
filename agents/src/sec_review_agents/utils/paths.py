from collections.abc import Mapping
from pathlib import Path
from typing import Any


def required_path(value: object, *, label: str) -> Path:
    """Normalize one required serialized path at a workflow boundary.

    `value` is intentionally typed as `object` because it comes from an
    untrusted/dynamically shaped workflow payload. Only a non-empty string is
    accepted; successful calls always return `Path`.
    """
    if isinstance(value, str) and value.strip():
        return Path(value)
    raise KeyError(f"Missing path: {label}")


def artifact_path(artifact_paths: Mapping[str, Any], key: str) -> Path:
    """Return one stage artifact directory from the serialized path index.

    ``artifact_paths`` is the workflow-level mapping of stage names such as
    ``analyzer`` and ``mitigator`` to their artifact directories. This helper
    validates the requested key and performs the same string-to-``Path``
    boundary conversion as :func:`required_path`.

    The mapping typically looks like::

        {
            "analyzer": ".../artifacts/analyzer",
            "mitigator": ".../artifacts/mitigator",
            "verifier": ".../artifacts/verifier",
            "cvss": ".../artifacts/cvss",
        }

    For example, ``artifact_path(artifact_paths, "analyzer")`` returns the
    analyzer artifact directory as a ``Path``.
    """
    value = artifact_paths.get(key)
    if isinstance(value, str) and value.strip():
        return Path(value)
    raise KeyError(f"Missing artifact path: {key}")
