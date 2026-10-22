"""Long-lived process entrypoints and the boundaries around them.

The package contains the long-lived Execution Worker plus short-lived local tools.

``execution_worker.main``
    The Temporal execution worker. It polls the task queue and runs review,
    extraction, and maintenance workflows and activities; it does not expose
    an HTTP API.
The remaining command-line entrypoints are short-lived clients or local tools.
When adding a long-lived entrypoint, document which of these process roles it
belongs to and keep its external boundary explicit.
"""

__all__: list[str] = []
