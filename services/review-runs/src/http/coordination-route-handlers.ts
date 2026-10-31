import { randomUUID } from 'node:crypto'

import { submitExecutionRun } from '../execution-client.js'
import { submitPreparedRun } from '../runtime/prepared-submission.js'
import type { ReviewRunStore } from '../persistence/review-run-store.js'
import type { OperationHandlers } from './route-handlers.js'

export function buildCoordinationRouteHandlers(store: ReviewRunStore) {
  return {
    admitRun: async (request) => {
      const body = request.body
      if (
        body.preparation_input === undefined ||
        body.preparation_input_version === undefined
      )
        throw new Error('Preparation input is required for run admission.')
      return await store.admissions.admit({
        ...body,
        preparation_input: body.preparation_input,
        preparation_input_version: body.preparation_input_version,
        run_id: randomUUID()
      })
    },

    submitPreparedRun: async (request) => {
      const { runId } = request.params
      const { preparation_token, publish_context, input } = request.body
      return await submitPreparedRun(
        store,
        {
          runId,
          preparationToken: preparation_token,
          publishContext: publish_context,
          input
        },
        submitExecutionRun
      )
    },

    reserveInputBundleCandidate: async (request) => {
      const { runId } = request.params
      const { token, ...intent } = request.body
      return await store.inputBundleCandidates.reserve(runId, token, intent)
    },
    listInputBundleCandidates: async (request) => {
      const { runId } = request.params
      const { token } = request.body
      return await store.inputBundleCandidates.list(runId, token)
    },
    settleInputBundleCandidate: async (request) => {
      const { runId } = request.params
      const { token, digest, status } = request.body
      return await store.inputBundleCandidates.settle(
        runId,
        token,
        digest,
        status
      )
    },
    renewPreparationClaim: async (request) => {
      const { runId } = request.params
      const { token } = request.body
      return await store.preparations.renewClaim(runId, token)
    },

    claimNextPreparation: async () => await store.preparations.claimNext(),

    checkpointPreparationInput: async (request) => {
      const { runId } = request.params
      const { token, input } = request.body
      await store.preparations.checkpointInput(runId, token, input)
    },

    claimNextRunNotice: async () => await store.notices.claimNext(),

    renewRunNoticeClaim: async (request) => {
      const { noticeId } = request.params
      const { token } = request.body
      return await store.notices.renewClaim(noticeId, token)
    },

    failPreparation: async (request) => {
      const { runId } = request.params
      const { token, failure, retry, retry_after_ms } = request.body
      return await store.preparations.fail(runId, token, failure, {
        retry: retry ?? false,
        ...(retry_after_ms === undefined
          ? {}
          : { retryAfterMs: retry_after_ms })
      })
    },

    completeRunNotice: async (request) => {
      const { noticeId } = request.params
      const body = request.body
      return body.delivered
        ? await store.notices.complete(
            noticeId,
            body.token,
            true,
            body.comment_url
          )
        : await store.notices.complete(noticeId, body.token, false)
    },

    claimNextPublication: async (request) => {
      const { wait_ms } = request.body
      return await store.publicationClaims.claimNext(wait_ms ?? 0)
    },

    renewPublicationClaim: async (request) => {
      const { runId } = request.params
      const { token } = request.body
      return await store.publications.renewClaim(runId, token)
    },

    initializePublicationSteps: async (request, reply) => {
      const { runId } = request.params
      const { token, step_keys } = request.body
      await store.publications.initializePublicationSteps(
        runId,
        token,
        step_keys
      )
      return reply.code(200).send()
    },

    requirePublicationStepClaim: async (request, reply) => {
      const { runId, stepKey } = request.params
      const { token } = request.body
      await store.publications.requirePublicationStepClaim(
        runId,
        token,
        stepKey
      )
      return reply.code(200).send()
    },

    completePublicationStep: async (request) => {
      const { runId, stepKey } = request.params
      const { token, remote_object } = request.body
      return await store.publications.completePublicationStep(
        runId,
        token,
        stepKey,
        remote_object ?? {}
      )
    },

    settleExhaustedPublicationStep: async (request) => {
      const { runId, stepKey } = request.params
      const { token, found, remote_object } = request.body
      return await store.publications.settleExhaustedPublicationStep(
        runId,
        token,
        stepKey,
        found ? { found: true, remote: remote_object ?? {} } : { found: false }
      )
    },

    failPublicationStep: async (request) => {
      const { runId, stepKey } = request.params
      const { token, failure, retry } = request.body
      return await store.publications.failPublicationStep(
        runId,
        token,
        stepKey,
        failure,
        retry === undefined ? {} : { retry }
      )
    },

    completePublication: async (request) => {
      const { runId } = request.params
      const { token } = request.body
      return await store.publications.complete(runId, token)
    },

    failPublication: async (request) => {
      const { runId } = request.params
      const { token, failure, retry } = request.body
      return await store.publications.fail(runId, token, failure, { retry })
    },

    getInternalRun: async (request, reply) => {
      const { runId } = request.params
      const run = await store.queries.getRun(runId)
      if (run === null) return reply.code(404).send({ error: 'run_not_found' })
      return reply.send(run)
    },

    listInternalPublicationSteps: async (request, reply) => {
      const { runId } = request.params
      const run = await store.queries.getRun(runId)
      if (run === null) return reply.code(404).send({ error: 'run_not_found' })
      return reply.send(
        await store.publications.listPublicationSteps(run.run_id)
      )
    },

    getPreparationHeartbeatInterval: async () =>
      store.preparations.heartbeatIntervalMs(),

    getPublicationHeartbeatInterval: async () =>
      store.publications.heartbeatIntervalMs(),

    getRunNoticeHeartbeatInterval: async () =>
      store.notices.heartbeatIntervalMs()
  } satisfies Partial<OperationHandlers>
}
