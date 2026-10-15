"""Single source of truth for the integration contract version.

Kept in its own module with no imports (not even third-party ones) so the build
hook in ``hatch_build.py`` can import it in an isolated build environment, where
the runtime dependencies (``jsonschema``, ``referencing``) are not installed.
Both the runtime (``entrypoints/contract_schema.py``) and the build read the
version from here, so it is defined exactly once.
"""

# CONTRACT_VERSION is the version this runner produces and expects.
CONTRACT_VERSION = "v6"

# CONTRACT_VERSION_DIR is the on-disk directory name that holds the schemas. It
# currently equals the version string, but it is a separate concept: the location
# of the contract files and the identity of the contract version are different
# concerns, so callers reference this name rather than a version literal.
CONTRACT_VERSION_DIR = CONTRACT_VERSION

__all__ = ["CONTRACT_VERSION", "CONTRACT_VERSION_DIR"]
