import type { WorkflowName } from '../src/infrastructure/runner/client.js'
import type { PublishContext } from '../src/infrastructure/runner/publish-context.js'

export function publishContextForWorkflow(workflow: WorkflowName): PublishContext {
  if (workflow === 'issue-review') {
    return {
      issue: {
        owner_login: 'octo',
        repo_name: 'example',
        repo_full_name: 'octo/example',
        default_branch: 'main',
        issue_number: 7,
        issue_title: 'Example issue'
      },
      workspace_ref: 'workspace-sha',
      event_type: 'manual_review'
    }
  }
  if (workflow === 'pull-request-review') {
    return {
      pr: {
        owner_login: 'octo',
        repo_name: 'example',
        repo_full_name: 'octo/example',
        pr_number: 7,
        pr_author: 'alice',
        head_sha: 'head-sha'
      },
      files: [],
      event_type: 'manual_review'
    }
  }
  return {
    repo: {
      owner_login: 'octo',
      repo_name: 'example',
      repo_full_name: 'octo/example',
      default_branch: 'main'
    },
    workspace_ref: 'workspace-sha',
    scan_target: { target_branch: 'main', scan_mode: 'full', base_sha: null, head_sha: 'head-sha' },
    event_type: 'manual'
  }
}
