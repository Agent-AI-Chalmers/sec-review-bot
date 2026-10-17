def request_export(caller, project_id, queue):
    project = load_project(project_id)  # noqa: F821 - external repository helper
    if project.tenant_id != caller.tenant_id:
        raise PermissionError("cross-tenant export denied")
    queue.send({"project_id": project_id})
