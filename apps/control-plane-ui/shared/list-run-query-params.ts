// Generated from contracts/review-runs-api/v1/openapi.yaml (path relative to the repository root). Do not edit.
//
// That document is the hand-written contract; this file is a projection of it, not a second
// copy. Regenerate it with `pnpm --dir contracts/review-runs-api/tools run generate`.
//
// The contract's `listRuns` operation declares these query parameters (as one form-exploded
// object). The console builds each request, and the BFF proxies it, from this one list, so
// neither can send a parameter the contract does not accept.

/** The query parameter names `listRuns` declares, in document order. */
export const LIST_RUN_QUERY_PARAMS = [
  'limit',
  'cursor',
  'execution_status',
  'publication_status',
  'preparation_status',
  'source_platform',
  'workflow',
  'from',
  'to'
] as const
