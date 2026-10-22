import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseIssueReviewPublishContext,
  parsePublishContextForWorkflow
} from '../../src/control-plane/publish-context.js'
import { EXECUTION_PUBLISH_ERROR_CODES } from '../../src/execution/publish-error-code.js'
import { publishContextForWorkflow } from '../publish-context-fixtures.js'

function assertInvalidPublishContext(operation: () => unknown): void {
  assert.throws(operation, (error) => {
    assert.strictEqual(
      (error as { code?: unknown }).code,
      EXECUTION_PUBLISH_ERROR_CODES.publish_context_invalid
    )
    return true
  })
}

test('workflow parsers retain only fields needed to resume publication', () => {
  assert.deepStrictEqual(
    parsePublishContextForWorkflow(
      'issue-review',
      publishContextForWorkflow('issue-review')
    ),
    {
      issue: {
        owner_login: 'octo',
        repo_name: 'example',
        repo_full_name: 'octo/example',
        default_branch: 'main',
        issue_number: 7,
        issue_title: 'Example issue'
      },
      workspace_ref: 'workspace-sha',
      event_type: 'manual_review',
      open_pr: false
    }
  )
  assert.deepStrictEqual(
    parsePublishContextForWorkflow(
      'pull-request-review',
      publishContextForWorkflow('pull-request-review')
    ),
    {
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
  )
  assert.deepStrictEqual(
    parsePublishContextForWorkflow(
      'repository-review',
      publishContextForWorkflow('repository-review')
    ),
    publishContextForWorkflow('repository-review')
  )
})

test('publish context rejects an unknown event instead of changing its meaning', () => {
  assertInvalidPublishContext(() =>
    parseIssueReviewPublishContext({
      ...publishContextForWorkflow('issue-review'),
      event_type: 'future_event'
    })
  )
})

test('publish context rejects incomplete nested entities', () => {
  assertInvalidPublishContext(() =>
    parseIssueReviewPublishContext({
      ...publishContextForWorkflow('issue-review'),
      issue: { repo_full_name: 'octo/example' }
    })
  )
})

test('publish context rejects repository identity fields that name different repositories', () => {
  for (const workflow of [
    'issue-review',
    'pull-request-review',
    'repository-review'
  ] as const) {
    const context = publishContextForWorkflow(workflow)
    const entityKey =
      workflow === 'issue-review'
        ? 'issue'
        : workflow === 'pull-request-review'
          ? 'pr'
          : 'repo'
    const entity = context[entityKey] as Record<string, unknown>
    assertInvalidPublishContext(() =>
      parsePublishContextForWorkflow(workflow, {
        ...context,
        [entityKey]: {
          ...entity,
          repo_full_name: 'another-owner/another-repo'
        }
      })
    )
  }
})

test('issue publish context defaults a missing open_pr to false', () => {
  const context = publishContextForWorkflow('issue-review') as Record<
    string,
    unknown
  >
  delete context.open_pr
  assert.strictEqual(parseIssueReviewPublishContext(context).open_pr, false)
})

test('issue publish context preserves an explicit open_pr opt-in', () => {
  const parsed = parseIssueReviewPublishContext({
    ...publishContextForWorkflow('issue-review'),
    open_pr: true
  })
  assert.strictEqual(parsed.open_pr, true)
})

test('issue publish context rejects a non-boolean open_pr', () => {
  assertInvalidPublishContext(() =>
    parseIssueReviewPublishContext({
      ...publishContextForWorkflow('issue-review'),
      open_pr: 'yes'
    })
  )
})

test('publish context projects away fields that publication does not own', () => {
  const parsed = parseIssueReviewPublishContext({
    ...publishContextForWorkflow('issue-review'),
    request_only_metadata: 'not persisted by the parser'
  })
  assert.strictEqual('request_only_metadata' in parsed, false)
})
