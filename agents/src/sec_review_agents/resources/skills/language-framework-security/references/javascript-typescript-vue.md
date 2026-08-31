# Vue Security Semantics

Use this reference when a Vue lead depends on templates, directives, router guards, stores, raw HTML, SSR, or client-side API calls.

## Entry Points

- Components, templates, directives, router guards, Pinia/Vuex stores, composables, SSR entry points, Markdown/rich-text renderers, and tests around the reported path.

## Rendering And XSS

- Vue escapes normal mustache bindings. Interpolation alone is not XSS.
- `v-html`, render functions creating raw HTML, custom directives that touch `innerHTML`, unsafe Markdown/rich-text rendering, and raw SSR output are escape hatches.
- Sanitizer presence proves only its configured element, attribute, protocol, and context coverage.

## Router Guards And Client Trust

- Router guards and client-side role checks do not prove server authorization.
- They can still be relevant if the app fetches or embeds sensitive data before the guard or exposes privileged client-side capability.

## Stores And Secrets

- Values in client stores, serialized hydration state, localStorage, sessionStorage, and browser bundles are client-visible.
- Public config is not automatically a leak; verify that the value is secret or security-sensitive.
