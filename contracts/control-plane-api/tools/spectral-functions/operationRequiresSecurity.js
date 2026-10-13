// Spectral custom function: every operation must declare its own `security`.
//
// The document has no top-level `security`, so an operation that omits the key inherits
// nothing and is mounted by fastify-openapi-glue with no authentication at all — a public
// endpoint created by a silent omission. This rule makes the omission a lint error: every
// operation must carry a `security` key.
//
// The key may hold a real requirement (`- serviceToken: []`) or be explicitly empty
// (`security: []`, which OpenAPI reads as "no requirement"). An explicit empty one is a
// deliberate, greppable act — the liveness probe uses it — whereas a missing key is not, so
// the rule distinguishes them rather than keeping a separate list of public paths: which
// operations *may* be public is a review question, not one a hard-coded allow-list here
// could answer without restating the contract.
//
// This is ES modules, not CommonJS: Spectral's ruleset migrator imports the `functionsDir`
// entry (`ctx.tree.addImport`), so an `export default` resolves fine; the earlier CommonJS
// was unnecessary. It returns result objects rather than calling `context.report`, which is
// how Spectral 6's plain function form communicates findings.

export default function operationRequiresSecurity(operation, _options, context) {
  if (Array.isArray(operation.security)) return

  // `context.path` is [...pathSegments, method, ...]; the path string is two up from here
  // because `given` selected the operation. This reads Spectral's path array shape, which is
  // the only way a function can recover the path key it is being run against.
  const path = context.path[context.path.length - 2]
  return [
    {
      message: `${path} must declare a security requirement (use \`security: []\` if it is deliberately public).`,
      path: [...context.path, 'security']
    }
  ]
}
