# System error intake and local repair bridge

The deployed application stores fixed diagnostic labels in a dedicated DynamoDB
queue. A deterministic local daemon reads and claims new rows using the existing
AWS profile, then calls the existing loopback Orchestrator. Empty queues never
invoke Codex. Codex uses the existing ChatGPT subscription login; no API key,
Claude login or outbound email is needed.

## Application integration

`POST /api/system-errors` requires an existing verified inventory session and
owner, `Content-Type: application/json`, `X-Bello-Error-Report: 1`, and a matching
Origin. Native clients may omit Origin only with `X-Bello-Mobile: 1` and no
browser `Sec-Fetch-Site`; the same verified session is still mandatory. A supplied
foreign Origin is always rejected. Authentication/permission failures, validation
errors and offline/network failures should not be reported as system defects.

The contract is `lib/systemErrors/contract.ts`. Required fields are `code`,
`surface`, `operation`, and `component`; optional `errorClass` and numeric `digest`
are allowlisted. All extra properties are discarded. Never pass messages, stacks,
URLs, headers, cookies, request bodies, product/customer identifiers, prices or
object snapshots. Server error hooks use
`reportServerSystemError(signal)` from `lib/systemErrors/server.ts` with fixed
route/component templates, never an actual request path.

The backend output `custom.systemErrors` selects the exact queue and region.
`BELLO_SYSTEM_ERRORS_ENABLED=0` disables reporting. Deployment creates only a
dedicated encrypted pk/sk table with seven-day TTL and scoped compute-role
GetItem/PutItem/UpdateItem permission, using the existing managed policy slot.
There is no public worker endpoint. Existing business tables are untouched.

Transactions deduplicate the same labels/build/day and enforce 10 distinct
events per actor/hour and 100 globally/hour. Failed writes return unavailable;
they never claim the error was queued. Request bodies are capped at 4096 bytes.

## Local activation

After deployment/review, configure the existing Orchestrator with a Codex-only
`local-next-isolated` profile, exact allowed files, required independent
verification, and the existing reviewed frozen-bundle/local-staging gate. Restart
the existing service to load the new operator-only
`POST /api/eco/system-error` handler. Keep its listener bound to loopback.
This endpoint never changes settings, resumes a suspended run or releases an
approval gate. Production publishing is outside this bridge.

When the reviewed host profile/frozen bundle/browser adapter is not ready, use
`{"table":"<queue>","region":"us-west-2","intakeOnly":true}`. This mode needs
no local operator credential and makes no local/model requests: it records each
new diagnostic as `NEEDS_OPERATOR / PROFILE_REQUIRED`. Queue collection is then
operational; automatic implementation/staging is explicitly not operational.
Once the real host is reviewed and connected, remove `intakeOnly`, configure the
loopback URL/operator credential, and explicitly retry the held events.

The existing local-next pipeline represents baseline QA as NOT_RUN/BLOCKED and
can proceed to specification/implementation. TESTING still requires a reviewed
exact frozen bundle, and final QA requires the real approved browser adapter.
These gates must remain in place; no successful browser/staging evidence is
implied by code edits or a passing unit test.

Create a local configuration file, outside the repository:

```json
{
  "table": "<custom.systemErrors.tableName>",
  "region": "us-west-2",
  "orchestratorUrl": "http://127.0.0.1:4317/",
  "operatorTokenFile": "C:/path/to/existing/eco-operator-token"
}
```

If the existing dashboard requires a second credential, supply its existing
`dashboardTokenFile`. Credential contents are read locally and never logged.
Run from the application repository, with `AWS_PROFILE=Bello`:

```powershell
node --import tsx tools/bello-dev-orchestrator/src/intake/systemErrorBridge.mjs C:/path/to/bridge.json --once
node --import tsx tools/bello-dev-orchestrator/src/intake/systemErrorBridge.mjs C:/path/to/bridge.json
```

The normal idle interval is 15 seconds; deterministic failures back off to
60 seconds. A Windows hidden/background startup task can run the latter command
after the actual subscription fixture and deployment checks pass. Installation
or a configuration file alone is not proof that a model executed successfully.
The local `system-error-bridge-status.json` beside the configuration records only
mode, process ID, last successful poll, failure count and bounded counters. A
custom local `statusFile` is optional. It contains no token, error payload or
business data. `--once` returns a nonzero exit status if its poll fails. In
intake-only mode the status explicitly says `automaticRepairReady:false`.

## States and intervention

`PENDING` → `CLAIMED` → `DISPATCHED` → `VERIFIED_LOCAL` means that the existing
eco run actually reached `COMPLETED_STAGING`. It never means production was
updated. `FAILED` records a failed/cancelled eco run. `NEEDS_OPERATOR` records a
dispatch/configuration/auth/limit failure; no model is retried automatically.
Provider capacity/auth, human review, pauses and frozen-bundle approval remain
visible under a dispatched event and its existing run. The daemon only observes
these states; it never approves or resumes them.

New automatic repair tasks are limited to one active task and three per UTC day.
An event replay reuses the same task/run. Task creation and PAUSED state are
committed atomically, so a crash never exposes a legacy runnable task. Claims
expire after two minutes and allow at most three automatic attempts. A lost ACK
is reconciled through the same stable event/task/run keys.

```powershell
# Show the first bounded page of current event/task/run states (no credentials).
node --import tsx tools/bello-dev-orchestrator/src/intake/systemErrorBridge.mjs C:/path/to/bridge.json --status
# After fixing a dispatch issue, explicitly requeue one NEEDS_OPERATOR/expired claim.
node --import tsx tools/bello-dev-orchestrator/src/intake/systemErrorBridge.mjs C:/path/to/bridge.json --retry '<event-id>'
```

Retry does not bypass or restart a suspended/terminal eco run. Inspect the existing
task/run in the Orchestrator dashboard and use its established operator process.
Keep the PC, AWS profile session, Orchestrator and daemon available for local
automatic repair. Remote errors remain queued while the PC is unavailable.

## Verification

```powershell
node --import tsx --test lib/systemErrors/systemErrors.test.ts
node --test tools/bello-dev-orchestrator/test/system-error-bridge.test.mjs tools/bello-dev-orchestrator/test/eco-service-runtime.test.mjs tools/bello-dev-orchestrator/test/eco-mode-queue.test.mjs
```

These cover redaction/allowlists, browser/native auth and origin boundaries,
body bounds, unavailable persistence, concurrent duplicate/flood budgets,
atomic held tasks, replay after dispatch failure, wrong profiles/scopes,
operator authorization, empty polling, pagination and preserved approval gates.
An actual isolated Codex fixture, independent review and staging evidence must
be recorded separately before claiming the repair service is operational.
