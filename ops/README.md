# Operations

This directory contains runtime provisioning and host-service integration that is not owned by one application package.

- `systemd/` installs and configures the host-managed Control Plane and execution worker services.
- `rustfs-init/` provisions the local RustFS bucket, runtime identities, and least-privilege policies used by the integrated stack.

The repository-level [`compose.yaml`](../compose.yaml) remains the integrated local orchestration entry point. Service Dockerfiles remain beside the applications they build, and operational procedures live in [`docs/operations/`](../docs/operations/).
