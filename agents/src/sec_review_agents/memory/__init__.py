"""Extracted experience memory production and runtime consumption.

Memory has two mutually exclusive state modes. Local mode uses
``AGENT_MEMORY_DIR`` for the memory tree and asynchronous processing state:

    AGENT_MEMORY_DIR/
      memory/                 # memory
        MEMORY.md             # startup index, mounted for agents as /memory/MEMORY.md
        topics/               # detailed lessons, mounted as /memory/topics/
      observations/           # unreviewed extraction outputs
      memory_state.sqlite     # local observation ledger

Main review agents only receive the ``memory/`` subtree as ``/memory``.
The observation files and SQLite state stay outside that memory view and are
used by extraction/maintenance workflows.

In coordinated mode, workers use ``AGENT_MEMORY_CATALOG_URL`` instead. External
services persist shared observations and revisions, while the catalog provides
the compare-and-swap commit boundary for the active revision. Immutable memory
tree artifacts and compressed memory-agent transcripts are stored in object
storage. Workers materialize the active revision's memory tree locally and
expose the same read-only ``/memory`` view to review agents; they do not fall
back to ``AGENT_MEMORY_DIR``.
"""
