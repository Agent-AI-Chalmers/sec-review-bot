// Boots the GitHub integration process and connects ingress handlers with its
// background coordination loops; domain workflows remain in their own modules.
import http from 'http'
import { createNodeMiddleware } from '@octokit/webhooks'

import { createGitHubApp } from './github-app.js'
import {
  port,
  repository_review_dispatch_path,
  webhook_max_body_bytes,
  webhook_path
} from './config.js'
import {
  currentAppBotLogin,
  setGitHubAppMetadata
} from './github/github-app-metadata-service.js'
import { createAppHttpHandler } from './ingress/http/app-http-handler.js'
import { handleRepositoryReviewDispatch } from './ingress/github/actions/repository-review-http-handler.js'
import { handleIssueCommentCreated } from './ingress/github/webhooks/issue-comment-created.js'
import { handleIssueOpened } from './ingress/github/webhooks/issue-opened.js'
import { handlePullRequestOpened } from './ingress/github/webhooks/pull-request-opened.js'
import { handlePullRequestReadyForReview } from './ingress/github/webhooks/pull-request-ready-for-review.js'
import { handlePullRequestSynchronize } from './ingress/github/webhooks/pull-request-synchronize.js'
import { verifyGitWorkspaceRuntime } from './artifacts/git-workspace.js'
import { verifyContractSchemasLoadable } from './execution/execution-api-schema.js'
import { startPublicationCoordinator } from './review-runs/publication-coordinator.js'
import { startPreparationCoordinator } from './review-runs/preparation-coordinator.js'
import { startRunNoticeCoordinator } from './review-runs/run-notice-coordinator.js'
import { backgroundPreparations } from './reviews/background-preparations.js'
import { logError, logInfo } from './utils/logger.js'

await verifyGitWorkspaceRuntime()
verifyContractSchemasLoadable()

const app = createGitHubApp()

const { data } = await app.octokit.request('/app')
setGitHubAppMetadata({
  id: data.id,
  slug: data.slug,
  name: data.name
})
// The bot login - `<slug>[bot]` - is what decides whether a comment, review, or PR belongs to
// this app, so every attribution check depends on it. Without a slug the app would still start,
// but would be unable to answer "is this ours?": marker reuse would throw on the publication
// path, and the webhook guard would silently drop every bot event. Refuse to start instead of
// running in that state, where the only visible symptom is work that quietly never happens.
if (currentAppBotLogin() === null) {
  throw new Error(
    'GitHub App metadata from /app has no slug; the app bot login cannot be determined.'
  )
}
app.octokit.log.debug(`Authenticated as '${data.name}'`)

app.webhooks.on('issue_comment.created', handleIssueCommentCreated)
app.webhooks.on('issues.opened', handleIssueOpened)
app.webhooks.on('pull_request.opened', handlePullRequestOpened)
app.webhooks.on(
  'pull_request.ready_for_review',
  handlePullRequestReadyForReview
)
app.webhooks.on('pull_request.synchronize', handlePullRequestSynchronize)
const publicationCoordinator = startPublicationCoordinator({ app })
const preparationCoordinator = startPreparationCoordinator({ app })
const runNoticeCoordinator = startRunNoticeCoordinator({ app })

app.webhooks.onError((error) => {
  if (error.name === 'AggregateError') {
    logError('webhook_dispatch_failed', {
      error_message: error?.message,
      event: error.event,
      name: error.name
    })
  } else {
    logError('webhook_dispatch_failed', {
      error
    })
  }
})

const localWebhookUrl = `http://localhost:${port}${webhook_path}`
const middleware = createNodeMiddleware(app.webhooks, { path: webhook_path })
const server = http.createServer(
  createAppHttpHandler({
    app,
    port,
    repository_review_dispatch_path,
    repository_review_dispatch_handler: handleRepositoryReviewDispatch,
    webhook_max_body_bytes,
    webhook_middleware: middleware
  })
)

server.listen(port, () => {
  logInfo('server_started', {
    dispatch_url: `http://localhost:${port}${repository_review_dispatch_path}`,
    webhook_url: localWebhookUrl
  })
})

let shutdownStarted = false
const shutdownSignals = ['SIGINT', 'SIGTERM'] as const
type ShutdownSignal = (typeof shutdownSignals)[number]

function closeServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

async function shutdown(signal: ShutdownSignal): Promise<void> {
  if (shutdownStarted) {
    return
  }
  shutdownStarted = true
  logInfo('server_shutdown_started', { signal })

  // Finish in-flight HTTP handlers first so every admitted preparation has been
  // registered before the tracker takes its shutdown snapshot.
  const serverResult = await Promise.allSettled([closeServer()])
  const results = [
    ...serverResult,
    ...(await Promise.allSettled([
      publicationCoordinator.stop(),
      preparationCoordinator.stop(),
      runNoticeCoordinator.stop(),
      backgroundPreparations.stop()
    ]))
  ]
  const shutdownError = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  )?.reason
  if (shutdownError !== undefined) {
    process.exitCode = 1
    logError('server_shutdown_failed', { error: shutdownError, signal })
    return
  }
  logInfo('server_shutdown_completed', { signal })
}

for (const signal of shutdownSignals) {
  process.once(signal, () => {
    void shutdown(signal)
  })
}
