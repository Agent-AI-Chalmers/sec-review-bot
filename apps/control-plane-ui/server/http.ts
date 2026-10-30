import type { IncomingMessage, ServerResponse } from 'node:http'

/** JSON content type for a body this BFF writes itself. */
export const PROXIED_CONTENT_TYPE = 'application/json; charset=utf-8'

export function sendJson(
  response: ServerResponse,
  status: number,
  body: object
): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

export const MAX_REQUEST_BODY_BYTES = 1024 * 1024

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super('Request body exceeds the configured limit.')
    this.name = 'RequestBodyTooLargeError'
  }
}

/** Read one bounded request body while preserving the caller's own parse and error policy. */
export async function readBoundedRequestBody(
  request: IncomingMessage,
  maximumBytes = MAX_REQUEST_BODY_BYTES
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > maximumBytes) throw new RequestBodyTooLargeError()
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}
