import type { ServerResponse } from 'node:http'

export const PROXIED_CONTENT_TYPE = 'application/json; charset=utf-8'

export class UpstreamResponseTooLargeError extends Error {
  constructor() {
    super('Upstream JSON response exceeds the size limit.')
    this.name = 'UpstreamResponseTooLargeError'
  }
}

export async function readBoundedUpstreamBody(
  response: Response,
  maximumBytes: number
): Promise<Buffer> {
  const contentLength = response.headers.get('content-length')
  if (
    contentLength !== null &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > maximumBytes
  ) {
    await response.body?.cancel()
    throw new UpstreamResponseTooLargeError()
  }
  if (response.body === null) return Buffer.alloc(0)

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximumBytes) {
        await reader.cancel()
        throw new UpstreamResponseTooLargeError()
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, size)
}

export async function readBoundedUpstreamJson(
  response: Response,
  maximumBytes: number
): Promise<unknown> {
  return JSON.parse(
    (await readBoundedUpstreamBody(response, maximumBytes)).toString('utf8')
  )
}

export function sendJson(
  response: ServerResponse,
  status: number,
  body: object
): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}
