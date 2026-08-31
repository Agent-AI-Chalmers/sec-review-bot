export interface GitHubErrorResponse {
  status: number | undefined
  headers: Record<string, unknown> | undefined
  data: {
    message: string | undefined
    errors: unknown
  } | undefined
}

export interface ErrorWithResponse {
  message: string | undefined
  name: string | undefined
  response: GitHubErrorResponse | undefined
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toGitHubErrorResponse (value: unknown): GitHubErrorResponse | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  const dataRecord = isRecord(value.data) ? value.data : undefined

  return {
    status: typeof value.status === 'number' ? value.status : undefined,
    headers: isRecord(value.headers) ? value.headers : undefined,
    data: dataRecord
      ? {
          message: typeof dataRecord.message === 'string' ? dataRecord.message : undefined,
          errors: dataRecord.errors
        }
      : undefined
  }
}

export function asErrorWithResponse (error: unknown): ErrorWithResponse {
  if (error instanceof Error) {
    const withMaybeResponse = error as Error & { response?: unknown }
    return {
      message: error.message,
      name: error.name,
      response: toGitHubErrorResponse(withMaybeResponse.response)
    }
  }

  if (isRecord(error)) {
    return {
      message: typeof error.message === 'string' ? error.message : undefined,
      name: typeof error.name === 'string' ? error.name : undefined,
      response: toGitHubErrorResponse(error.response)
    }
  }

  return {
    message: String(error),
    name: undefined,
    response: undefined
  }
}

export function getErrorMessage (error: unknown): string {
  return asErrorWithResponse(error).message ?? String(error)
}

export function isGitHubErrorResponse (value: unknown): value is GitHubErrorResponse {
  return toGitHubErrorResponse(value) !== undefined
}
