import http from 'http'
import { createNodeMiddleware } from '@octokit/webhooks'

import { createGitHubApp } from './github-app.js'
import { port, repository_review_dispatch_path, webhook_path } from './config.js'
import { setGitHubAppMetadata } from './infrastructure/github/github-app-metadata-service.js'
import { createAppHttpHandler } from './interfaces/http/app-http-handler.js'
import { handleRepositoryReviewDispatch } from './interfaces/github/actions/repository-review-http-handler.js'
import { handleIssueCommentCreated } from './interfaces/github/webhooks/issue-comment-created.js'
import { handleIssueOpened } from './interfaces/github/webhooks/issue-opened.js'
import { handlePullRequestOpened } from './interfaces/github/webhooks/pull-request-opened.js'
import { handlePullRequestReadyForReview } from './interfaces/github/webhooks/pull-request-ready-for-review.js'
import { handlePullRequestSynchronize } from './interfaces/github/webhooks/pull-request-synchronize.js'
import { verifyGitWorkspaceRuntime } from './infrastructure/runner/git-workspace.js'
import { startRunnerRunPublisher } from './infrastructure/runner/run-publisher.js'
import { logError, logInfo } from './utils/logger.js'

await verifyGitWorkspaceRuntime()

const app = createGitHubApp()

const { data } = await app.octokit.request('/app')
setGitHubAppMetadata({
  id: data.id,
  slug: data.slug,
  name: data.name
})
app.octokit.log.debug(`Authenticated as '${data.name}'`)

app.webhooks.on('issue_comment.created', handleIssueCommentCreated)
app.webhooks.on('issues.opened', handleIssueOpened)
app.webhooks.on('pull_request.opened', handlePullRequestOpened)
app.webhooks.on('pull_request.ready_for_review', handlePullRequestReadyForReview)
app.webhooks.on('pull_request.synchronize', handlePullRequestSynchronize)
startRunnerRunPublisher({ app })

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
const server = http.createServer(createAppHttpHandler({
  app,
  port,
  repository_review_dispatch_path,
  repository_review_dispatch_handler: handleRepositoryReviewDispatch,
  webhook_middleware: middleware
}))

server.listen(port, () => {
  logInfo('server_started', {
    dispatch_url: `http://localhost:${port}${repository_review_dispatch_path}`,
    webhook_url: localWebhookUrl
  })
})
