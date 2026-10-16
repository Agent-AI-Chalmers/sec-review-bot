# CWE-699 Agent Navigation

This document reorganizes MITRE CWE View-699 (Software Development) into an agent-friendly navigation aid.

This is an incomplete local index, not an allowed-label list or a security coverage inventory. The inherited selection is not a complete export of View-699. Labels absent here remain eligible; verify the official entry and its mapping usage when assigning a label.

## Usage Rules

- Treat first-level entries as navigation categories, not final vulnerability labels.
- Prefer an accurate Base or Variant with allowed mapping usage; an appropriate Class is acceptable when no accurate Base or Variant fits. Do not select by depth in this view.
- Never map a real vulnerability directly to a CWE Category.
- Use categories only to orient further investigation. If no suitable mapping can be verified, explain the issue in prose rather than forcing a label from this index.
- Use this document as a classification prior, not as proof. Repository evidence still decides the final label.

## Selected Category Navigation

### CWE-1211: Authentication Errors

Weaknesses in this category are related to authentication components of a system.

- `CWE-289`: Authentication Bypass by Alternate Name
- `CWE-290`: Authentication Bypass by Spoofing
- `CWE-294`: Authentication Bypass by Capture-replay
- `CWE-308`: Use of Single-factor Authentication
- `CWE-603`: Use of Client-Side Authentication

### CWE-1006: Bad Coding Practices

Unsafe coding and maintenance practices that increase the likelihood of exploitable weaknesses.

- `CWE-489`: Active Debug Code / Leftover debug code
- `CWE-563`: Assignment to Variable without Use / Unused Variable
- `CWE-654`: Reliance on a Single Factor in a Security Decision / single-factor security decision
- `CWE-1116`: Inaccurate Source Code Comments

### CWE-438: Behavioral Problems

Unexpected or dangerous behaviors caused by how the product behaves under certain inputs or protocol states.

- `CWE-439`: Functional change
- `CWE-444`: HTTP Request Smuggling / HTTP Response Smuggling / HTTP Smuggling
- `CWE-698`: Execution After Redirect (EAR) / Redirect Without Exit

### CWE-840: Business Logic Errors

High-level application workflow and state-transition mistakes that can be abused without necessarily breaking low-level code assumptions.

- `CWE-639`: Insecure Direct Object Reference / IDOR / Broken Object Level Authorization / BOLA / Horizontal Authorization
- `CWE-708`: Incorrect Ownership Assignment

### CWE-417: Communication Channel Errors

Improper handling of alternate paths, channels, or access routes.

- `CWE-425`: Direct Request ("Forced Browsing")
- `CWE-918`: Server-Side Request Forgery (SSRF) / XSPA

### CWE-1226: Complexity Issues

Problems where excessive complexity creates exploitable failure modes or denial-of-service conditions.

- `CWE-1333`: ReDoS / Regular Expression Denial of Service / Catastrophic backtracking

### CWE-1214: Data Integrity Issues

Weaknesses that degrade trust in the integrity or authenticity of data.

- `CWE-348`: Use of Less Trusted Source

### CWE-19: Data Processing Errors

Weaknesses in application logic that incorrectly transforms, interprets, or routes data.

- `CWE-130`: Length manipulation / length tampering
- `CWE-472`: Assumed-Immutable Parameter Tampering
- `CWE-601`: Open Redirect / Cross-site Redirect / Cross-domain Redirect / Unvalidated Redirect
- `CWE-611`: Improper Restriction of XML External Entity Reference / XXE
- `CWE-776`: XML Entity Expansion / XEE / Billion Laughs Attack / XML Bomb

### CWE-137: Data Neutralization Issues

Classic injection-style weaknesses caused by failing to neutralize dangerous syntax or formats.

- `CWE-78`: Shell injection / OS Command Injection
- `CWE-79`: Cross-site Scripting / XSS / HTML Injection / Reflected XSS / Stored XSS / DOM-Based XSS
- `CWE-89`: SQL injection / SQLi
- `CWE-94`: Code Injection
- `CWE-117`: Improper Output Neutralization for Logs / Log forging
- `CWE-917`: EL Injection
- `CWE-1236`: CSV Injection / Formula Injection / Excel Macro Injection

### CWE-1219: File Handling Issues

Weaknesses related to files, paths, directories, and file-system semantics.

- `CWE-22`: Directory traversal / Path traversal
- `CWE-59`: Insecure temporary file / Zip Slip
- `CWE-426`: Untrusted Search Path / Untrusted Path
- `CWE-427`: Uncontrolled Search Path Element / DLL preloading / Binary planting / Insecure library loading / Dependency confusion

### CWE-389: Error Conditions, Return Values, Status Codes

Weaknesses caused by incorrect handling of rare, exceptional, or failure-state conditions.

- `CWE-617`: Reachable Assertion / assertion failure

### CWE-429: Handler Errors

Weaknesses caused by improper management of handlers or externally invokable processing endpoints.

- `CWE-434`: Unrestricted File Upload

### CWE-199: Information Management Errors

Improper handling, exposure, or retention of sensitive or security-relevant information.

- `CWE-359`: Privacy violation / Privacy leak / Privacy leakage / PII / PHI

### CWE-452: Initialization and Cleanup Errors

Weaknesses in setup, teardown, cleanup, and lifecycle transitions.

- `CWE-459`: Incomplete Cleanup / Insufficient Cleanup

### CWE-1215: Data Validation Issues

Input, output, and policy validation mistakes.

- `CWE-183`: Permissive List of Allowed Inputs / Allowlist / Safelist
- `CWE-184`: Incomplete List of Disallowed Inputs / Denylist / Blocklist

### CWE-1218: Memory Buffer Errors

Memory safety issues involving reads, writes, bounds, and buffer layout.

- `CWE-120`: Classic Buffer Overflow / Unbounded Transfer
- `CWE-124`: Buffer Underwrite / Buffer Underflow
- `CWE-125`: Out-of-bounds Read / OOB read
- `CWE-787`: Out-of-bounds Write / Memory Corruption

### CWE-189: Numeric Errors

Arithmetic, size, sign, and numeric-conversion mistakes.

- `CWE-190`: Integer Overflow or Wraparound
- `CWE-191`: Integer Underflow
- `CWE-193`: Off-by-one Error
- `CWE-839`: Numeric Range Comparison Without Minimum Check / signed comparison

### CWE-465: Pointer Issues

Weaknesses involving pointer validity, lifetime, and offset handling.

- `CWE-476`: NULL Pointer Dereference / NPD / NPE / null deref / nil pointer dereference
- `CWE-823`: Use of Out-of-range Pointer Offset / Untrusted pointer offset
- `CWE-825`: Expired Pointer Dereference / Dangling pointer

### CWE-265: Privilege Issues

Incorrect privilege allocation, privilege transitions, or overly powerful execution contexts.

- `CWE-250`: Execution with Unnecessary Privileges
- `CWE-266`: Incorrect Privilege Assignment
- `CWE-267`: Privilege Defined With Unsafe Actions
- `CWE-268`: Privilege Chaining
- `CWE-270`: Privilege Context Switching Error
- `CWE-272`: Least Privilege Violation
- `CWE-273`: Improper Check for Dropped Privileges
- `CWE-648`: Incorrect Use of Privileged APIs

### CWE-411: Resource Locking Problems

Locking and unlock semantics on shared resources.

- `CWE-413`: Improper Resource Locking
- `CWE-764`: Multiple Locks of a Critical Resource
- `CWE-765`: Multiple Unlocks of a Critical Resource
- `CWE-832`: Unlock of a Resource that is not Locked

### CWE-399: Resource Management Errors

Resource lifecycle and availability mistakes beyond locking alone.

- `CWE-403`: File descriptor leak
- `CWE-470`: Reflection Injection
- `CWE-502`: Deserialization of Untrusted Data / Marshaling / Unmarshaling / Pickling / Unpickling / PHP Object Injection
- `CWE-908`: Use of Uninitialized Resource
- `CWE-910`: Use of Expired File Descriptor / Stale file descriptor
- `CWE-915`: Mass Assignment / AutoBinding / PHP Object Injection

### CWE-136: Type Errors

Weaknesses caused by unsafe assumptions about runtime type identity or representation.

- `CWE-843`: Object Type Confusion

### CWE-355: User Interface Security Issues

Security weaknesses involving user-visible presentation, trust cues, or interaction framing.

- `CWE-1007`: Homograph Attack
- `CWE-1021`: Clickjacking / UI Redress Attack / Tapjacking

## Additional Category Navigation

These categories have no expanded examples in this local index. This does not mean that the agent cannot analyze or classify their weaknesses.

- `CWE-1228`: API / Function Errors
- `CWE-1210`: Audit / Logging Errors
- `CWE-1212`: Authorization Errors
- `CWE-557`: Concurrency Issues
- `CWE-255`: Credentials Management Errors
- `CWE-310`: Cryptographic Issues
- `CWE-320`: Key Management Errors
- `CWE-1225`: Documentation Issues
- `CWE-1227`: Encapsulation Issues
- `CWE-569`: Expression Issues
- `CWE-1216`: Lockout Mechanism Errors
- `CWE-275`: Permission Issues
- `CWE-387`: Signal Errors
- `CWE-371`: State Issues
- `CWE-133`: String Errors
- `CWE-1213`: Random Number Issues
- `CWE-1217`: User Session Errors

## Notes for Agents

- Check the official weakness definition, abstraction, and mapping usage. Category membership and local list membership do not establish the correct label.
- If a finding is fundamentally a business-logic flaw, keep the prose explanation primary and use the CWE label only as a supporting anchor.
- If a finding is a chain or composite phenomenon, one CWE may not tell the whole story; explain the exploit path in prose even if you attach a primary CWE.
- Treat `Separation of Privilege` as ambiguous: MITRE uses it around both compartmentalization (`CWE-653`, not expanded in this index) and single-factor security decisions (`CWE-654`), so map by repository facts and the official entries rather than by that phrase alone.
- Do not force a precise CWE when repository evidence is still ambiguous.
