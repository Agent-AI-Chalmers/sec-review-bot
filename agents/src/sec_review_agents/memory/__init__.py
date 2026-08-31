"""Extracted experience memory support.

On disk, ``AGENT_MEMORY_DIR`` is a store for both memory and the
asynchronous extraction pipeline:

    AGENT_MEMORY_DIR/
      memory/                 # memory
        MEMORY.md             # startup index, mounted for agents as /memory/MEMORY.md
        topics/               # detailed lessons, mounted as /memory/topics/
      observations/           # unreviewed extraction outputs
      memory_state.sqlite     # observation ledger and extraction-job state

Main review agents only receive the ``memory/`` subtree as ``/memory``.
The observation files and SQLite state stay outside that memory view and are
used by extraction/maintenance workflows.
"""
