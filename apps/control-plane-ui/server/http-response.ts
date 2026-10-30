import type { ServerResponse } from 'node:http'

/**
 * The content type of a JSON body this BFF writes itself.
 *
 * Upstream bodies are relayed unchanged; this is for the responses the BFF serialises, so
 * the console sees one content type across every route.
 */
export const PROXIED_CONTENT_TYPE = 'application/json; charset=utf-8'

export function sendJson(
  response: ServerResponse,
  status: number,
  body: object
): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}
