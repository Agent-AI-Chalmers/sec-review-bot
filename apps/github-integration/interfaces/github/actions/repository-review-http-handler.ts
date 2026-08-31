import type { IncomingMessage, ServerResponse } from 'http'

import {
  repository_review_dispatch_max_body_bytes,
  repository_review_dispatch_read_timeout_ms
} from '../../../config.js'
import {
  dispatchRepositoryReview,
  RepositoryReviewDispatchValidationError
} from '../../../triggers/repository-review.js'
import { splitRepoFullName } from '../../../infrastructure/github/repository-service.js'
import {
  authorizeRepositoryReviewDispatchOidc,
  RepositoryReviewOidcError,
  type GitHubActionsOidcVerifier
} from './oidc-authorizer.js'
import {
  normalizeRepositoryReviewDispatchPayload,
  type RepositoryReviewDispatchPayload
} from '../../../triggers/repository-review.js'
import { logError } from '../../../utils/logger.js'
import type { App } from 'octokit'

interface DispatchContext {
  app: App
  request: IncomingMessage
  response: ServerResponse
  dispatchReview?: typeof dispatchRepositoryReview
  oidcVerifier?: GitHubActionsOidcVerifier
}

function writeJson (response: ServerResponse, status_code: number, value: Record<string, unknown>): void {
  response.writeHead(status_code, {
    'content-type': 'application/json; charset=utf-8'
  })
  response.end(JSON.stringify(value))
}

class DispatchBodyReadError extends Error {
  constructor (
    message: string,
    readonly status_code: number
  ) {
    super(message)
    this.name = 'DispatchBodyReadError'
  }
}

function positiveIntegerOrDefault (value: number, default_value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : default_value
}

async function readBody (request: IncomingMessage): Promise<Buffer> {
  const maxBodyBytes = positiveIntegerOrDefault(repository_review_dispatch_max_body_bytes, 1_048_576)
  const readTimeoutMs = positiveIntegerOrDefault(repository_review_dispatch_read_timeout_ms, 10_000)

  // Keep request size and time bounded before parsing or authentication work.
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalBytes = 0
    let done = false
    const timer = setTimeout(() => {
      fail(new DispatchBodyReadError('Dispatch request body read timed out.', 408))
      request.destroy()
    }, readTimeoutMs)

    const cleanup = (): void => {
      clearTimeout(timer)
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('error', onError)
    }

    const fail = (error: Error): void => {
      if (done) {
        return
      }
      done = true
      cleanup()
      reject(error)
    }

    function onData (chunk: Buffer | string): void {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      totalBytes += buffer.byteLength
      if (totalBytes > maxBodyBytes) {
        fail(new DispatchBodyReadError('Dispatch request body is too large.', 413))
        request.destroy()
        return
      }
      chunks.push(buffer)
    }

    function onEnd (): void {
      if (done) {
        return
      }
      done = true
      cleanup()
      resolve(Buffer.concat(chunks, totalBytes))
    }

    function onError (error: Error): void {
      fail(error)
    }

    request.on('data', onData)
    request.on('end', onEnd)
    request.on('error', onError)
  })
}

function asErrorMessage (error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

export async function handleRepositoryReviewDispatch ({ app, request, response, dispatchReview = dispatchRepositoryReview, oidcVerifier }: DispatchContext): Promise<void> {
  if (request.method !== 'POST') {
    writeJson(response, 405, {
      ok: false,
      error: 'Method not allowed.'
    })
    return
  }

  let raw_body: Buffer
  try {
    raw_body = await readBody(request)
  } catch (error) {
    if (error instanceof DispatchBodyReadError) {
      writeJson(response, error.status_code, {
        ok: false,
        error: error.message
      })
      return
    }
    throw error
  }
  let payload: RepositoryReviewDispatchPayload
  try {
    payload = normalizeRepositoryReviewDispatchPayload(JSON.parse(raw_body.toString('utf8')))
  } catch {
    writeJson(response, 400, {
      ok: false,
      error: 'Dispatch request body is not valid JSON.'
    })
    return
  }

  const repo_full_name = String(payload.repo_full_name ?? '').trim()
  const target_branch = String(payload.target_branch ?? '').trim()

  if (!repo_full_name) {
    writeJson(response, 400, {
      ok: false,
      error: 'repo_full_name is required.'
    })
    return
  }

  if (!target_branch) {
    writeJson(response, 400, {
      ok: false,
      error: 'target_branch is required.'
    })
    return
  }

  try {
    splitRepoFullName(repo_full_name)
  } catch (error) {
    logError('repository_review_dispatch_validation_failed', {
      error,
      error_message: asErrorMessage(error),
      event: 'repository-review-dispatch',
      repo: repo_full_name
    })
    writeJson(response, 400, {
      ok: false,
      error: asErrorMessage(error) || 'Repository review dispatch request is invalid.'
    })
    return
  }

  try {
    await authorizeRepositoryReviewDispatchOidc({
      headers: request.headers,
      payload_repo_full_name: repo_full_name,
      payload_target_branch: target_branch,
      ...(oidcVerifier ? { verifier: oidcVerifier } : {})
    })
  } catch (error) {
    if (error instanceof RepositoryReviewOidcError) {
      writeJson(response, error.status_code, {
        ok: false,
        error: error.message
      })
      return
    }
    throw error
  }

  try {
    const submitted = await dispatchReview({
      app,
      payload
    })

    writeJson(response, 202, {
      ok: true,
      accepted: true,
      status: 'queued',
      run_id: submitted.run_id,
      repo_full_name,
      summary_issue_url: null
    })
  } catch (error) {
    if (error instanceof RepositoryReviewDispatchValidationError) {
      writeJson(response, 400, {
        ok: false,
        error: error.message || 'Repository review dispatch request is invalid.'
      })
      return
    }
    logError('repository_review_dispatch_failed', {
      error,
      error_message: asErrorMessage(error),
      event: 'repository-review-dispatch',
      repo: repo_full_name
    })
    writeJson(response, 500, {
      ok: false,
      error: 'Repository review dispatch failed.'
    })
  }
}
