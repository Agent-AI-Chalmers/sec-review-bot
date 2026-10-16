# Windows Filesystem Authority

- Distinguish the path string, Win32 or NT namespace interpretation, reparse-point traversal, the opened object and the object's security descriptor.
- Verify normalization and namespace behavior for the exact API. Prefixes, drive-relative paths, alternate streams and reparse points can change what object a string names; string-prefix containment is not an access-control decision.
- `FILE_FLAG_OPEN_REPARSE_POINT` can open a reparse point itself in supported `CreateFile` modes. Do not treat it as a general guarantee that every intermediate path component was confined.
- Evaluate access against the relevant token and the object's DACL or other enforcing policy. A path under a nominally protected directory is not sufficient if an untrusted actor can replace a traversed component or modify its security descriptor.

Report only when an untrusted actor can influence naming, replacement or permissions and the resulting open reaches an unauthorized object or operation. Preserve uncertainty when the API, namespace, token, DACL or reparse-point mutability is unknown.
