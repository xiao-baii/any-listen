# Multi-user code review (2026-09-12)

Scope: changes from upstream 80cce020, including gateway authentication, account RPC permissions, media requests, publication and container packaging. This is a focused source review and regression run, not a penetration-test certification.

## Findings Addressed

- High: an authenticated user could send the media URL proxy to a private service or cloud metadata endpoint. The managed shared HTTP client now validates resolved addresses at connection time, connects to that exact address, and repeats validation on redirects. Outbound proxies cannot override it. Exact-origin exceptions are server configuration only. Tests cover literal private addresses, localhost DNS, IPv4-mapped IPv6 classification, redirect escape and ordinary gateway rejection.
- Medium: the documented admin-password.txt and dotenv files could enter Docker's build context. Git and Docker exclusions now cover the bootstrap password, dotenv files and account SQLite files; Docker also excludes PEM and key files. Ignore rules are preventive and do not remove previously committed secrets. The reviewed tracked filenames contained no actual bootstrap password, dotenv, key or account database files; documented preview credentials are disposable local fixtures.
- Medium: child processes inherited the host temporary directory. TEMP, TMP and TMPDIR now point to each account's own temp directory.
- Previously fixed: a delayed administrator request could outlive session revocation while uploading its body or deriving a password. Session authorization is rechecked immediately before account mutations; regression tests cover revoked writes.

## Remaining Risks and Limits

- High trust boundary: administrators can install executable extensions. All account processes share the container OS user and filesystem; process isolation is not a security sandbox. A malicious or compromised extension can bypass the shared HTTP library and access other account files. Only trusted administrators and reviewed extensions are supported.
- Availability: no account/process limit was requested. Authenticated users can keep processes and streams alive; 2 GB may be exhausted. Request volume, password changes, disk growth and extension work are not globally quota-controlled. Deployment still needs resource observation and ingress rate limits.
- Network compatibility: private-origin exceptions grant every account access to the whole configured origin. Keep them narrowly scoped. The public client selects one validated DNS address; hosts relying on address fallback may need retry or a later connection fallback improvement.
- Extension readiness relies on the supported LX loader's success log marker. Upgrades must repeat compatibility tests. Publication failure messages are in-memory, while the committed version and audit event are persisted.
- The obsolete migration command has been removed; existing migration files are not modified.
- The full Svelte check has 171 errors / 19 warnings matching the upstream baseline. This is an existing type-check gap, not a clean frontend type check.

## Verification

- After the outbound and temporary-directory changes: Web build passed; 10 account/security/integration tests passed.
- Production dependency audit reported zero known advisories across 185 dependencies. This is the registry audit result at review time, not proof of absence of vulnerabilities.
- Official extensions passed before these final network changes. Their rerun after the changes was blocked when the session filesystem permissions changed; it must run again in CI.
- Desktop build passed before the final shared HTTP client changes. Repeat its build in CI.
- Docker/Linux 2 GB load tests, production HTTPS proxy behavior and administrator-provided real LX scripts remain unverified.

The multi-user GitHub workflow runs the account check, Web build, account tests, official extension test and desktop build. Custom release tags and manual runs on multi-user export a Docker TAR to Actions artifacts. The workflow no longer logs in to or publishes to GHCR, and has no packages write permission.
