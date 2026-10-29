# Development fixture data

These files are sanitized, reduced examples of application artifacts. They retain representative manifest, trajectory message, tool-call, usage, and file-tree shapes without including repository identities, credentials, environment data, full prompts, workspace contents, or model reasoning.

Keep these fixtures small and deterministic. Add only the fields needed to exercise a browser behavior, and never make development fixtures depend on external or machine-local data.

Cross-resource references must remain coherent. A memory observation's source run must exist in the run fixtures and must have completed execution with the trajectory-producing artifact available; extraction, observation, overview, and revision projections must describe the same records. GitLab runs are intentionally retained as UI examples even though the repository does not yet provide a GitLab integration.
