# Bounded sale diagnostic routing

The existing single `inventory_web` profile may declare a host-owned
`systemErrorRepair` catalog. This does not enable the bridge or the eco runtime.
Only the local authenticated system-error endpoint uses this catalog; remote
diagnostics cannot choose profiles, paths, commands, models or instructions.

The catalog contains `enabled: true`, `schemaVersion: 1`, a trusted deployed
full 40-character `release`, its reviewed `sourceManifestSha256`, and `scopes`.
The host must establish deployment acceptance before installing that release.
There is no prefix, unknown-release, HEAD or default-profile fallback. The
repository must be clean at the exact approved commit before creating a task.

Each scope contains only exact source/test `allowedPaths` and required
`verification.commands` (bounded literal Node commands). Scope IDs are
subordinate repair scopes, never profile or target-app IDs.

| Server diagnostic | Component | Operation | Scope |
| --- | --- | --- | --- |
| SALE_AUTOMATION_FAILED | sale-automation | identify, verify | sale-policy-local |
| SALE_AUTOMATION_FAILED | sale-automation | sell | sale-ledger-local |
| SALE_AUTOMATION_FAILED | sale-automation | adjust | sale-reconciliation-local |
| SALE_LINK_FAILED | sale-automation | identify, verify, sell, adjust | sale-binding-local |
| SALE_EC_UNCONFIRMED | sale-automation | verify, adjust | sale-reconciliation-local |
| SALE_DESKTOP_FAILED | sale-desktop | identify, verify, adjust | sale-desktop-state-local |

Every other combination is held. Authentication/rate problems require
operational attention. Import and remote-format labels remain unsupported
because their fixed labels do not identify an unambiguous repair boundary.
An intentional fee/charge HOLD is not a source defect. An unconfirmed EC
outcome permits diagnosis only until a deterministic synthetic reproducer
identifies an actual source bug. Never resend an uncertain EC operation,
remove a fee guard, or rewrite business/job/receipt state as a repair.

Task registration atomically records a paused task and a digest-bound
`system_error_route` checkpoint before starting the eco run. The run revision
binds that checkpoint digest. One active automatic error task and three tasks
per UTC day remain the durable limits. Lost acknowledgement returns the same
task/run without issuing another operation, including after a release changes.
Changed event data under the same ID is rejected. Existing unbound automatic
error tasks cannot silently inherit the new profile.

Specification, implementation, edit checks, independent verification, staging
and final QA all select closures built from the captured exact scope/test plan.
Profile, scope, release, test or fixed isolation/model policy drift blocks later
phases. A newly reviewed bundle and native CUA session are separate envelopes:
they may be installed without changing the immutable repair scope. Their exact
source, test-plan and live-session checks remain enforced by the existing host.

Automatic repair requires a real `local-next-isolated` / `nextjs` host, an
approved pinned bundle, native `desktopCua`, and fresh ChatGPT subscription and
staging probes. The HTTP sale fixture is not a full-app repair host. An explicit
host-approved `gptBrowserQa: false` permits initial diagnosis without a live CUA
session; final `qaVerify` still uses the mandatory native CUA bridge. A patched
source stops for a fresh frozen-bundle review before independent tests/staging.
Production approval, no paid API fallback, and all source/data isolation gates
remain unchanged.

Verification: `node --test test/system-error-routing.test.mjs` exercises exact
routing, drift/replay/budgets, all phase selectors, and the real service factory
through bridge → authenticated API → held task → isolated eco run → baseline →
scoped specification. That finite replay deliberately uses a synthetic provider
capacity stop; it proves managed dispatch and preservation of the hold, not a
live model response, repaired source, native CUA pass or enabled production repair.
