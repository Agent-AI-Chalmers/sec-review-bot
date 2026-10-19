import { asErrorWithResponse } from '../../utils/error-utils.js'

/**
 * Whether a failed `git.createRef` means the branch already exists.
 *
 * `createRef` answers 422 both for "reference already exists" and for an invalid ref name, so the
 * status alone cannot tell a recoverable retry checkpoint from a real error. Only the response's
 * own message may be inspected: `error.message` is not a GitHub payload and can carry text from
 * anything on the path (a proxy, a wrapped error), so falling back to it could turn an unrelated
 * failure into a "the branch is already there, verify and reuse it" decision. When the response
 * carries no message the check answers `false`, which fails closed back to the caller's rethrow.
 *
 * This lives in one place because two publication paths (issue reviews and repository deliveries)
 * must agree: if they drifted, one could treat an invalid ref as recoverable while the other
 * rejected it.
 */
export function isBranchAlreadyExists(error: unknown): boolean {
  const errorInfo = asErrorWithResponse(error)
  if (errorInfo.status !== 422) return false
  const message = String(errorInfo.response?.data?.message ?? '').toLowerCase()
  return message.includes('already exists')
}
