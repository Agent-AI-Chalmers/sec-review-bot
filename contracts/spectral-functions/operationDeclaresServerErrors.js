// Spectral custom function: every operation declares the non-schema errors it can return.
//
// The service bounds every body at 1 MiB and has one app-level error handler, so two status
// codes are reachable that the contract's per-operation schemas never describe:
//
//   - `500` — any internal fault (the handler applies to every route), so every operation; and
//   - `413` — a body over the limit, so every operation that *reads* a body.
//
// The document's claim is that it is the single source of truth for the whole surface, so an
// operation that silently omits these understates it. This rule makes that omission a lint
// error: every operation must declare a `500` response, and every operation with a
// `requestBody` a `413`.
//
// It checks for the status key, not the response it points at: the shared
// `components.responses.InternalError` / `PayloadTooLarge` are the ones to reuse, but pinning
// the `$ref` target here would duplicate that decision rather than leave it to review.
export default function operationDeclaresServerErrors(
  operation,
  _options,
  context
) {
  const responses = operation.responses ?? {}
  const problems = []

  if (responses['500'] === undefined) {
    problems.push({
      message:
        'operation must declare a `500` response (any internal fault can return it).',
      path: [...context.path, 'responses']
    })
  }
  if (operation.requestBody !== undefined && responses['413'] === undefined) {
    problems.push({
      message:
        'operation reads a request body, so it must declare a `413` response.',
      path: [...context.path, 'responses']
    })
  }
  return problems
}
