"""Single source of truth for the integration contract version.

Kept in its own module with no imports (not even third-party ones) so the build
hook in ``hatch_build.py`` can import it in an isolated build environment, where
the runtime dependencies (``jsonschema``, ``referencing``) are not installed.
Both the runtime (``entrypoints/contract_schema.py``) and the build read the
version from here, so it is defined exactly once.
"""

# CONTRACT_VERSION is the version this runner produces and expects.
CONTRACT_VERSION = "v6"

__all__ = ["CONTRACT_VERSION"]
