interface GitHubErrorResponse {
  status: number | undefined
  headers: Record<string, unknown> | undefined
  data: {
    message: string | undefined
    errors: unknown
  } | undefined
}

interface ErrorWithResponse {
  message: string | undefined
  name: string | undefined
  status: number | undefined
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
    const withMaybeGitHubFields = error as Error & { response?: unknown, status?: unknown }
    const response = toGitHubErrorResponse(withMaybeGitHubFields.response)
    return {
      message: error.message,
      name: error.name,
      status: typeof withMaybeGitHubFields.status === 'number'
        ? withMaybeGitHubFields.status
        : response?.status,
      response
    }
  }

  if (isRecord(error)) {
    const response = toGitHubErrorResponse(error.response)
    return {
      message: typeof error.message === 'string' ? error.message : undefined,
      name: typeof error.name === 'string' ? error.name : undefined,
      status: typeof error.status === 'number' ? error.status : response?.status,
      response
    }
  }

  return {
    message: String(error),
    name: undefined,
    status: undefined,
    response: undefined
  }
}
