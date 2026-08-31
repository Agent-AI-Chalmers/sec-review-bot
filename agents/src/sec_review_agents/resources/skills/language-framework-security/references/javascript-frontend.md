# JavaScript Frontend Security Semantics

Use this reference when a frontend lead depends on browser DOM sinks, client-side routing, storage, postMessage, redirects, or trust in client-side checks.

## Entry Points

- Components, route loaders, client-side routers, event handlers, HTML rendering helpers, Markdown/rich-text renderers, storage helpers, postMessage handlers, redirect helpers, and tests.

## Client-Side Authority

- Client-side checks are useful UX but not server authorization. A missing or bypassable client check is security-relevant only if the server also trusts it or the client-side action itself exposes sensitive data or capability.

## DOM XSS

- Dangerous sinks include `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, raw template strings inserted as HTML, unsafe Markdown/HTML rendering, and scriptable URL contexts.
- Safe text sinks such as `textContent` are usually controls for HTML injection.
- Sanitizer presence proves only the tags, attributes, protocols, and contexts it actually covers.

## Storage And Secrets

- Anything shipped to the browser, stored in localStorage/sessionStorage, or embedded in HTML is client-visible. Do not treat frontend-held secrets as secret.
- Public config is not a leak merely because it is visible. Confirm the value is actually a credential, token, private endpoint, or sensitive data.

## postMessage And Redirects

- `postMessage` handlers need origin, source, and message-shape checks when they perform sensitive actions.
- Redirect helpers become open redirect candidates when attacker-controlled input can select an external destination used in auth, token, or trust flows.
