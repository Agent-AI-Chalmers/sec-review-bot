# Authorization And Delegation Security Source Notes

These sources support rules for non-browser service/workload identity, protocol- or credential-level delegation and impersonation, actor/subject distinction and confused deputies.

| ID and skill location | Primary source and locator | Supported decision and limit |
| --- | --- | --- |
| AUTHZ-1: workload identity; `service-workload-identity.md` | [SPIFFE ID specification](https://github.com/spiffe/spiffe/blob/main/standards/SPIFFE-ID.md), trust domains and workload identifiers; [SPIFFE X.509-SVID specification](https://github.com/spiffe/spiffe/blob/main/standards/X509-SVID.md), validation | Bind a verified workload identifier and trust domain to explicit permissions. A valid credential, short lifetime or shared service account does not establish the intended peer authorization. SPIFFE is an example specification, not a required platform. |
| AUTHZ-2: actor and subject; `delegated-authority.md` | [RFC 8693 OAuth 2.0 Token Exchange](https://www.rfc-editor.org/rfc/rfc8693.html), §§1.1, 4.1 and 4.4 | Delegation can represent both an actor and a subject. Require the actual protocol and downstream checks; do not demand RFC 8693 claims from unrelated systems. |
| AUTHZ-3: confused deputy; `delegated-authority.md` | [MITRE CWE-441](https://cwe.mitre.org/data/definitions/441.html), Description and consequences | Confirm that a requester can cause a deputy to exercise authority the requester lacks because an intended policy or binding is absent. Different service privilege alone is not a vulnerability. |
