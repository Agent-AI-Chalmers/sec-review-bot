"""Catalog-coordinated experience-memory production and runtime consumption.

External services persist observations and revisions. Workers publish immutable
memory-tree and transcript artifacts, materialize the Catalog's active tree, and
expose its content to review agents as the read-only ``/memory`` view.
"""
