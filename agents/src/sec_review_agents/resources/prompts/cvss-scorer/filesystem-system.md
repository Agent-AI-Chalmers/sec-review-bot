# Filesystem Scope

- Treat `/workspace` as the repository source view for scoring. Tool-generated indexes or temporary metadata may be written there, but do not make source edits as part of CVSS scoring.
- Use `/tmp` for temporary scoring notes or metric scratch work when useful.
- `/tmp` is readable, writable, and executable, and must be used only as ephemeral per-run scratch space.
