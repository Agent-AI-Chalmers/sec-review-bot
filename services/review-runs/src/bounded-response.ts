// Reading an upstream response under a byte budget.
//
// Every HTTP upstream this service talks to is untrusted about size: a proxy can answer with a
// body far larger than the caller's page, and buffering it before checking would already have
// cost the memory. The budget is therefore enforced twice — from the declared length before any
// body is read, and while streaming — and the reader is released either way.

/** A response whose body exceeded the caller's budget. */
export class ResponseTooLargeError extends Error {
  constructor(readonly maximumBytes: number) {
    super(`Response exceeds the ${maximumBytes}-byte budget.`)
    this.name = 'ResponseTooLargeError'
  }
}

/**
 * Read a response body, refusing one over the budget as it arrives.
 *
 * A declared `content-length` over the budget cancels the body before reading it, so an
 * over-large response costs no transfer. A body that grows past the budget is cancelled
 * mid-stream. Callers map the refusal to their own error, because "too large" means something
 * different per upstream.
 */
export async function readBoundedResponseBody(
  response: Response,
  maximumBytes: number
): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length')
  if (
    contentLength !== null &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > maximumBytes
  ) {
    await response.body?.cancel()
    throw new ResponseTooLargeError(maximumBytes)
  }
  if (response.body === null) return new Uint8Array(0)

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximumBytes) {
        await reader.cancel()
        throw new ResponseTooLargeError(maximumBytes)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}
