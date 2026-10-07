export class DeterministicControlPlaneError extends Error {
  readonly code: string

  constructor (message: string, code: string, options: ErrorOptions = {}) {
    super(message, options)
    this.name = 'DeterministicRunnerPublishError'
    this.code = code
  }
}
