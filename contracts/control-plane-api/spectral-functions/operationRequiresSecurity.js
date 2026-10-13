// Spectral custom function: every operation must require a credential.
//
// This document declares no top-level `security`, so each operation carries its own
// requirement. Nothing else enforced that: an operation written without `security` passes
// Spectral and is mounted by fastify-openapi-glue with no authentication at all, so the
// omission is silent and the endpoint is public. A `truthy` check on the `security` field
// almost expresses the rule, but the liveness probe is a deliberate exception — it must
// answer an unauthenticated caller — and Spectral's built-in functions cannot express
// "except this path" inside a single rule. Hence a custom function rather than a `then`.
//
// CommonJS and `.js` are required here: Spectral 6 loads a `functionsDir` entry as
// `require('<functionsDir>/<name>.js')`, so an `.mjs` module is not resolvable. The function
// returns result objects rather than calling `context.report`, which is how Spectral 6's
// plain function form communicates findings.
//
// The exception list is one entry long and intentionally explicit: adding a second public
// operation should require editing this file and justifying it here.

/** Operations that must answer without a credential, and why. */
const PUBLIC_OPERATIONS = new Set(['/healthz'])

/** A blank security requirement (`security: []`, or `security: [{}]`) authenticates nobody,
 * so it must not satisfy the rule. */
function declaresCredential(security) {
  if (!Array.isArray(security)) return false
  return security.some(
    (requirement) =>
      typeof requirement === 'object' &&
      requirement !== null &&
      Object.keys(requirement).length > 0
  )
}

module.exports = function operationRequiresSecurity(operation, _options, context) {
  const path = context.path[context.path.length - 2]
  if (PUBLIC_OPERATIONS.has(path)) return
  if (declaresCredential(operation.security)) return

  return [
    {
      message: `${path} must declare a non-empty security scheme (only ${[...PUBLIC_OPERATIONS].join(', ')} may be public).`,
      path: [...context.path, 'security']
    }
  ]
}
