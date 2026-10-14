import type {
  fetchTrustedRepositoryTriggerConfig,
  isAutomaticTriggerModeEnabled,
  isRepositoryTriggerConfigError
} from '../../../github/repo-config-service.js'

/**
 * Shared request shape for webhook handlers. Handlers that expose a testable
 * `...WithDeps` variant accept this as their first argument so tests can pass a
 * minimal `{ id, octokit, payload }` object.
 */
export interface WebhookHandlerArgs {
  id: string
  octokit: unknown
  payload: unknown
}

/** Dependencies for reading the repository trigger config. */
export interface TriggerConfigHandlerDeps {
  fetchTrustedRepositoryTriggerConfigFn?: typeof fetchTrustedRepositoryTriggerConfig
  isAutomaticTriggerModeEnabledFn?: typeof isAutomaticTriggerModeEnabled
  isRepositoryTriggerConfigErrorFn?: typeof isRepositoryTriggerConfigError
}
