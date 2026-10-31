import type { InputBundlePublicationStore } from '../src/artifacts/input-bundle-publication.js'

/** Lightweight ledger boundary for trigger tests; protocol behavior has its own crash probes. */
export function inputBundlePublicationStore(): Pick<
  InputBundlePublicationStore,
  | 'reserveInputBundleCandidate'
  | 'listInputBundleCandidates'
  | 'settleInputBundleCandidate'
> {
  return {
    async listInputBundleCandidates() {
      return []
    },
    async reserveInputBundleCandidate(runId, _token, intent) {
      return {
        run_id: runId,
        digest: intent.reference.digest,
        ...intent,
        status: 'reserved'
      }
    },
    async settleInputBundleCandidate(runId, _token, digest, status) {
      return {
        run_id: runId,
        digest,
        status,
        reference: {
          uri: 'file:///tmp/bundle',
          digest,
          media_type: 'application/tar+zstd',
          size_bytes: 1
        },
        input: {},
        publish_context: {}
      }
    }
  }
}
