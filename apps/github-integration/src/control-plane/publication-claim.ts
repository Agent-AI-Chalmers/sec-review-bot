export class PublicationClaimLostError extends Error {
  constructor(runId: string, options?: ErrorOptions) {
    super(`Publication claim is no longer provably owned for review run ${runId}.`, options)
    this.name = 'PublicationClaimLostError'
  }
}

export function isPublicationClaimLostError(error: unknown): boolean {
  return error instanceof PublicationClaimLostError
}
