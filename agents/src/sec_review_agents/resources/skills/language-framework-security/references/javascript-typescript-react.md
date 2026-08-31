# React Security Semantics

Use this reference when a React lead depends on component rendering, props/state, server/client boundaries, router behavior, raw HTML, storage, or API calls.

## Entry Points

- Components, hooks, route loaders/actions, data-fetching helpers, rich-text renderers, Markdown/MDX rendering, auth context providers, storage helpers, and tests around the reported UI flow.

## Rendering And XSS

- React escapes ordinary string values in JSX. Interpolation alone is not XSS.
- `dangerouslySetInnerHTML`, raw Markdown/MDX, custom rich-text renderers, URL/script contexts, and direct DOM APIs are escape hatches.
- Sanitizers are controls only for the contexts and policies they actually cover.

## Client-Side Auth

- Client-side route guards, hidden buttons, disabled controls, or role checks do not prove server authorization.
- They can still matter for data exposure if sensitive data is fetched or shipped to the browser before the guard runs.

## State, Storage, And Secrets

- Props, serialized state, Redux stores, localStorage, sessionStorage, and browser bundles are client-visible.
- Public environment variables are expected to be visible. Confirm whether a value is truly secret before treating it as exposure.
