import type { resolveTrustedDefaultBranch } from '../../../github/default-branch-service.js'
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

/**
 * Dependencies for resolving the trusted default branch directly.
 *
 * Handlers that need a trigger config use `TriggerConfigHandlerDeps` (which
 * resolves the branch as part of reading the config); handlers that only need
 * the trusted ref itself use this.
 */
export interface TrustedRefHandlerDeps {
  resolveTrustedDefaultBranchFn?: typeof resolveTrustedDefaultBranch
}
