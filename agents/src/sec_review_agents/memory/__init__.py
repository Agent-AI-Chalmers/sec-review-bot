"""Extracted experience memory production and runtime consumption.

Memory has two mutually exclusive storage modes. Local execution uses
``AGENT_MEMORY_DIR`` for curated memory and asynchronous processing state:

    AGENT_MEMORY_DIR/
      memory/                 # memory
        MEMORY.md             # startup index, mounted for agents as /memory/MEMORY.md
        topics/               # detailed lessons, mounted as /memory/topics/
      observations/           # unreviewed extraction outputs
      memory_state.sqlite     # local observation ledger

Main review agents only receive the ``memory/`` subtree as ``/memory``.
The observation files and SQLite state stay outside that memory view and are
used by extraction/maintenance workflows.

Managed workers use ``AGENT_MEMORY_CATALOG_URL`` instead. Observations and the
active memory revision are coordinated through the catalog, while immutable
memory versions and audit bundles are stored in object storage. Workers
materialize the active version locally and expose the same read-only
``/memory`` view to review agents; they do not fall back to ``AGENT_MEMORY_DIR``.
"""
