import { randomUUID } from 'node:crypto'

import { submitExecutionRun } from '../execution-client.js'
import { submitPreparedRun } from '../runtime/prepared-submission.js'
import type { ReviewRunStore } from '../persistence/review-run-store.js'
import type { OperationHandlers } from './route-handlers.js'
import type { PathParams, RequestBody } from './route-types.js'

export function buildCoordinationRouteHandlers(
  store: ReviewRunStore
): OperationHandlers {
  return {
    admitRun: async (request) => {
      const body = request.body as RequestBody<'admitRun'>
      if (
        body.preparation_input === undefined ||
        body.preparation_input_version === undefined
      )
        throw new Error('Preparation input is required for run admission.')
      return await store.admitReviewRun({
        ...body,
        preparation_input: body.preparation_input,
        preparation_input_version: body.preparation_input_version,
        run_id: randomUUID()
      })
    },

    submitPreparedRun: async (request) => {
      const { runId } = request.params as PathParams<'submitPreparedRun'>
      const { preparation_token, publish_context, input } =
        request.body as RequestBody<'submitPreparedRun'>
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

    renewPreparationClaim: async (request) => {
      const { runId } = request.params as PathParams<'renewPreparationClaim'>
      const { token } = request.body as RequestBody<'renewPreparationClaim'>
      return await store.renewPreparationClaim(runId, token)
    },

    claimNextPreparation: async () => await store.claimNextPreparation(),

    checkpointPreparationInput: async (request) => {
      const { runId } =
        request.params as PathParams<'checkpointPreparationInput'>
      const { token, input } =
        request.body as RequestBody<'checkpointPreparationInput'>
      await store.checkpointPreparationInput(runId, token, input)
    },

    claimNextRunNotice: async () => await store.claimNextRunNotice(),

    renewRunNoticeClaim: async (request) => {
      const { noticeId } = request.params as PathParams<'renewRunNoticeClaim'>
      const { token } = request.body as RequestBody<'renewRunNoticeClaim'>
      return await store.renewRunNoticeClaim(noticeId, token)
    },

    failPreparation: async (request) => {
      const { runId } = request.params as PathParams<'failPreparation'>
      const { token, failure, retry, retry_after_ms } =
        request.body as RequestBody<'failPreparation'>
      return await store.failPreparation(runId, token, failure, {
        retry: retry ?? false,
        ...(retry_after_ms === undefined
          ? {}
          : { retryAfterMs: retry_after_ms })
      })
    },

    completeRunNotice: async (request) => {
      const { noticeId } = request.params as PathParams<'completeRunNotice'>
      const body = request.body as RequestBody<'completeRunNotice'>
      return body.delivered
        ? await store.completeRunNotice(
            noticeId,
            body.token,
            true,
            body.comment_url
          )
        : await store.completeRunNotice(noticeId, body.token, false)
    },

    claimNextPublication: async (request) => {
      const { wait_ms } = request.body as RequestBody<'claimNextPublication'>
      return await store.claimNextPublication(wait_ms ?? 0)
    },

    renewPublicationClaim: async (request) => {
      const { runId } = request.params as PathParams<'renewPublicationClaim'>
      const { token } = request.body as RequestBody<'renewPublicationClaim'>
      return await store.renewPublicationClaim(runId, token)
    },

    initializePublicationSteps: async (request, reply) => {
      const { runId } =
        request.params as PathParams<'initializePublicationSteps'>
      const { token, step_keys } =
        request.body as RequestBody<'initializePublicationSteps'>
      await store.initializePublicationSteps(runId, token, step_keys)
      return reply.code(200).send()
    },

    requirePublicationStepClaim: async (request, reply) => {
      const { runId, stepKey } =
        request.params as PathParams<'requirePublicationStepClaim'>
      const { token } =
        request.body as RequestBody<'requirePublicationStepClaim'>
      await store.requirePublicationStepClaim(runId, token, stepKey)
      return reply.code(200).send()
    },

    completePublicationStep: async (request) => {
      const { runId, stepKey } =
        request.params as PathParams<'completePublicationStep'>
      const { token, remote_object } =
        request.body as RequestBody<'completePublicationStep'>
      return await store.completePublicationStep(
        runId,
        token,
        stepKey,
        remote_object ?? {}
      )
    },

    settleExhaustedPublicationStep: async (request) => {
      const { runId, stepKey } =
        request.params as PathParams<'settleExhaustedPublicationStep'>
      const { token, found, remote_object } =
        request.body as RequestBody<'settleExhaustedPublicationStep'>
      return await store.settleExhaustedPublicationStep(
        runId,
        token,
        stepKey,
        found ? { found: true, remote: remote_object ?? {} } : { found: false }
      )
    },

    failPublicationStep: async (request) => {
      const { runId, stepKey } =
        request.params as PathParams<'failPublicationStep'>
      const { token, failure, retry } =
        request.body as RequestBody<'failPublicationStep'>
      return await store.failPublicationStep(
        runId,
        token,
        stepKey,
        failure,
        retry === undefined ? {} : { retry }
      )
    },

    completePublication: async (request) => {
      const { runId } = request.params as PathParams<'completePublication'>
      const { token } = request.body as RequestBody<'completePublication'>
      return await store.completePublication(runId, token)
    },

    failPublication: async (request) => {
      const { runId } = request.params as PathParams<'failPublication'>
      const { token, failure, retry } =
        request.body as RequestBody<'failPublication'>
      return await store.failPublication(runId, token, failure, { retry })
    },

    getInternalRun: async (request, reply) => {
      const { runId } = request.params as PathParams<'getInternalRun'>
      const run = await store.getRun(runId)
      if (run === null) return reply.code(404).send({ error: 'run_not_found' })
      return reply.send(run)
    },

    listInternalPublicationSteps: async (request, reply) => {
      const { runId } =
        request.params as PathParams<'listInternalPublicationSteps'>
      const run = await store.getRun(runId)
      if (run === null) return reply.code(404).send({ error: 'run_not_found' })
      return reply.send(await store.listPublicationSteps(run.run_id))
    },

    getPreparationHeartbeatInterval: async () =>
      store.preparationHeartbeatIntervalMs(),

    getPublicationHeartbeatInterval: async () =>
      store.publicationHeartbeatIntervalMs(),

    getRunNoticeHeartbeatInterval: async () =>
      store.runNoticeHeartbeatIntervalMs()
  }
}
