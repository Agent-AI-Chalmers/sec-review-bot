import { requestUpstream, type UpstreamResult } from './request.js'

export type MemoryArtifactCollection = 'revisions' | 'extractions'

export interface MemoryCatalogClient {
  read(path: string): Promise<UpstreamResult>
  getArtifactRecord(
    collection: MemoryArtifactCollection,
    identity: string
  ): Promise<UpstreamResult>
  write(path: string, body: unknown): Promise<UpstreamResult>
}

/** Memory Catalog reads and operator writes, with the operator token owned by this client. */
export function createMemoryCatalogClient({
  baseUrl,
  operatorToken,
  requestTimeoutMs,
  maximumResponseBytes
}: {
  baseUrl: string
  operatorToken: string
  requestTimeoutMs: number
  maximumResponseBytes: number
}): MemoryCatalogClient {
  const options = {
    timeoutMs: requestTimeoutMs,
    maximumBytes: maximumResponseBytes
  }
  const headers = { authorization: `Bearer ${operatorToken}` }

  return {
    read: (path) => requestUpstream(`${baseUrl}${path}`, { headers }, options),
    getArtifactRecord: (collection, identity) =>
      requestUpstream(
        `${baseUrl}/v1/${
          collection === 'revisions' ? 'memory-tree/revisions' : 'extractions'
        }/${encodeURIComponent(identity)}`,
        { headers },
        options
      ),
    write: (path, body) =>
      requestUpstream(
        `${baseUrl}${path}`,
        {
          method: 'POST',
          headers: {
            ...headers,
            'content-type': 'application/json'
          },
          body: JSON.stringify(body)
        },
        options
      )
  }
}
