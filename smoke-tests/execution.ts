import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { gateway, request, runs } from './http.js'
import { serviceToken, readToken, executionToken } from './credentials.js'
import type { Admission } from './review-runs.js'

type Execution = { run_id: string; workflow: string; status: string }
type Conflict = { run_id: string; error: { code: string } }
type Input = { input_bundle: Record<string, unknown>; issue: { title: string } }
type Description = {
  workflowExecutionInfo: { execution: { workflowId: string; runId: string } }
}

type ObservedRun = { run: { preparation: { status: string } } }

function loadInput() {
  const bundle = process.env.SMOKE_INPUT_BUNDLE
  assert.ok(bundle, 'SMOKE_INPUT_BUNDLE is required')
  return {
    ...(JSON.parse(readFileSync('/smoke/issue-review-input.json', 'utf8')) as Input),
    input_bundle: JSON.parse(bundle) as Record<string, unknown>
  }
}

export async function submit(): Promise<void> {
  const savedAdmission = process.env.SMOKE_ADMISSION
  assert.ok(savedAdmission, 'SMOKE_ADMISSION is required')
  const admission = JSON.parse(savedAdmission) as Admission
  const runId = admission.record.run_id
  const input = loadInput()
  const publishContext = { smoke: true }
  const token = admission.preparation_token
  const candidatePath = `/v1/runs/${runId}/input-bundle-candidates`
  await request({
    base: runs,
    method: 'POST',
    path: candidatePath,
    expectedStatus: 200,
    token: serviceToken,
    json: {
      token,
      reference: input.input_bundle,
      input,
      publish_context: publishContext
    }
  })
  await request({
    base: runs,
    method: 'POST',
    path: `${candidatePath}/settle`,
    expectedStatus: 200,
    token: serviceToken,
    json: {
      token,
      digest: input.input_bundle.digest,
      status: 'present'
    }
  })
  const submission = (await (
    await request({
      base: runs,
      method: 'POST',
      path: `/v1/runs/${runId}/submission`,
      expectedStatus: 200,
      token: serviceToken,
      json: {
        preparation_token: token,
        publish_context: publishContext,
        input
      }
    })
  ).json()) as Execution
  assert.equal(submission.run_id, runId)
  assert.equal(submission.status, 'queued')
  const execution = (await (
    await request({
      base: gateway,
      method: 'GET',
      path: `/v1/runs/${runId}`,
      expectedStatus: 200,
      token: executionToken
    })
  ).json()) as Execution
  assert.equal(execution.run_id, runId)
  assert.equal(execution.workflow, 'issue-review')
  assert.equal(execution.status, 'running')
  const observed = (await (
    await request({
      base: runs,
      method: 'GET',
      path: `/v1/runs/${runId}`,
      expectedStatus: 200,
      token: readToken
    })
  ).json()) as ObservedRun
  assert.equal(observed.run.preparation.status, 'submitted')
  // stdout is reserved for the workflow ID consumed by the shell.
  console.log(runId)
}

export async function verifyReplay(runId: string): Promise<void> {
  // Read before replay so a restarted Gateway must recover the existing execution.
  const existing = (await (
    await request({
      base: gateway,
      method: 'GET',
      path: `/v1/runs/${runId}`,
      expectedStatus: 200,
      token: executionToken
    })
  ).json()) as Execution
  assert.equal(existing.run_id, runId)
  assert.equal(existing.workflow, 'issue-review')
  assert.equal(existing.status, 'running')
  const input = loadInput()
  const path = '/v1/workflows/issue-review/runs'
  const replay = (await (
    await request({
      base: gateway,
      method: 'POST',
      path: path,
      expectedStatus: 202,
      token: executionToken,
      json: {
        run_id: runId,
        input
      }
    })
  ).json()) as Execution
  assert.equal(replay.run_id, runId)
  assert.equal(replay.status, 'running')
  const changed = structuredClone(input)
  changed.issue.title += ' (conflicting submission)'
  const conflict = (await (
    await request({
      base: gateway,
      method: 'POST',
      path: path,
      expectedStatus: 409,
      token: executionToken,
      json: {
        run_id: runId,
        input: changed
      }
    })
  ).json()) as Conflict
  assert.equal(conflict.run_id, runId)
  assert.equal(conflict.error.code, 'EXECUTION_RUN_CONFLICT')
  const execution = (await (
    await request({
      base: gateway,
      method: 'GET',
      path: `/v1/runs/${runId}`,
      expectedStatus: 200,
      token: executionToken
    })
  ).json()) as Execution
  assert.equal(execution.status, 'running')
  console.error('ok: Gateway accepted identical replay and rejected changed input')
}

export function verifyExecutionIdentity(
  runId: string,
  beforeJson: string,
  afterJson: string
): void {
  const before = (JSON.parse(beforeJson) as Description).workflowExecutionInfo.execution
  const after = (JSON.parse(afterJson) as Description).workflowExecutionInfo.execution
  assert.equal(before.workflowId, runId)
  assert.equal(after.workflowId, runId)
  assert.equal(typeof before.runId, 'string')
  assert.ok(before.runId.length > 0)
  assert.equal(after.runId, before.runId)
  console.error('ok: Replay and conflict preserved the original Temporal execution')
}
