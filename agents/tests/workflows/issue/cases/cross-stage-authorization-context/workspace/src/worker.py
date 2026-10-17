def run_export(message, organization_storage):
    project = load_project(  # noqa: F821 - external repository helper
        message["project_id"]
    )
    return organization_storage.export(project.storage_path)
