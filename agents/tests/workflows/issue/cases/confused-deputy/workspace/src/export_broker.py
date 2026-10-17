def export_project(caller, target_project, operation, organization_client):
    if not caller.may_invoke_automation:
        raise PermissionError("automation denied")
    return organization_client.perform(target_project, operation)
