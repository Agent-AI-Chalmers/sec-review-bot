# XSS Source/Sink Reference

Use this reference when a web lead involves script execution, raw HTML, DOM insertion, framework escape hatches, or template rendering.

## Sources

- User-controlled text from request params, query strings, form fields, profile fields, comments, markdown, uploaded documents, CMS content, issue/PR text, or external API content.
- Browser-controlled values such as `location`, hash fragments, `postMessage`, local/session storage, cookies, and DOM text when they flow into rendering logic.
- Server-rendered data inserted into templates or hydration payloads.

## Sinks

- Raw DOM/HTML writes: `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, jQuery `.html()` / `.append()` with HTML strings.
- React escape hatches: `dangerouslySetInnerHTML`, unsafe custom markup helpers, direct DOM writes in effects/refs.
- Angular escape hatches: `bypassSecurityTrustHtml`, `bypassSecurityTrustScript`, unsafe `[innerHTML]` patterns.
- Vue escape hatches: `v-html`, runtime template compilation with user content.
- Template engines with disabled escaping, raw filters, triple-stash output, or untrusted template strings.
- URL and attribute contexts that can execute code, including untrusted `href` / `src` / `srcdoc`, `javascript:` or dangerous `data:` URLs, event handler attributes, and framework router/link helpers that do not validate schemes.
- Inline JavaScript, JSON hydration, or script/template contexts where attacker data can break out of a quoted value, tag, attribute, or data block.
- CSS or style contexts only when repository evidence shows browser-supported script execution, sensitive data exfiltration, policy bypass, or another concrete security effect.
- JavaScript execution sinks: `eval`, `new Function`, string-valued `setTimeout` / `setInterval`, dynamic script creation from untrusted URLs.

## Guards

- Framework default text interpolation that escapes by default.
- Context-appropriate output encoding in server templates.
- URL scheme allowlists for navigational attributes and router/link helpers.
- Sanitizers such as DOMPurify when configured for the actual rendered context.
- Trusted Types or CSP can reduce impact but does not by itself prove the sink is safe.

## Report Conditions

- The finding should connect attacker-controlled content to a concrete HTML/script execution sink.
- State the rendering or execution context, affected file/path, whether sanitization or encoding applies, and what security effect follows.
- If the data source is only local developer input, trusted config, or static content, do not report without repository evidence that an attacker can control it.

## False-Positive Precedents

- Ordinary React, Angular, Vue, or similar framework text interpolation is not XSS by itself.
- Client-side form validation absence is not XSS by itself.
- URL display, logging, or debug output is not XSS unless it reaches an executable browser context.
- A dangerous sink name alone is not enough; source reachability and missing/insufficient neutralization must be shown.
