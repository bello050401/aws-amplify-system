# Inventory staging foundation repair

Task `task_80fd0179983b8f1d13`; host adapter task `task_39e21bc418c4b17ae3`. Codex implemented and independently reviewed this change in isolated worktrees. Initial CLI worker used gpt-6.1-sol/high; bounded residual and actual MXC adapter workers used gpt-6.1-sol/medium. The initial eco run timed out after transport interruption; its state is HUMAN_REVIEW, not successful. Follow-up work and tests are recorded as host-managed phases.

This is delivery infrastructure, not evidence that the inventory feature, production authentication or AWS schema has been deployed. No paid cloud resources were created and no operational application settings were changed.

## Delivery contracts

`createStagingDelivery` selects exactly one adapter:

| mode | adapter | accepted evidence |
| --- | --- | --- |
| `static-smoke` | `AmplifyStaticDelivery` | bounded text-only HTML and exact HTTP byte hash |
| `local-build-evidence` | `LocalEvidenceDelivery` | Photo Station/Store Simulator independent build/test and committed local UI evidence |
| `real-staging` with `framework: nextjs` | `NextStagingDelivery` | disconnected until an audited immutable cloud transport is supplied; a RELEASE commitId is not proof that Amplify built that checkout |
| `local-next-isolated` | `LocalNextDelivery` | host-enforced sandbox, live PID/port/instance and real revision API |

Unknown modes and production fallbacks are errors. A Next.js app never enters the static upload adapter. All adapters expose `row(taskId)`, `prepare(task)`, `preflight()` and `advance(task)`; persisted rows retain `commit_id` even on intermediate responses. Existing operator authentication, production approval, worktree scope enforcement and model routing are unchanged.

Next.js receipts contain the settings snapshot and `{commit, fingerprint, plan}` from a currently passing independent verifier and exact clean worktree HEAD. A committed `package.json` declaring Next and a committed Next page are required. Existing diff, infrastructure/build-spec and GitHub workflow checks are reused for cloud releases. The approved branch must **already** contain that exact commit: this adapter does not push an unpublished revision. Cloud success additionally requires a matching job ID/commit and live HTTP identity. Health is not inferred from AWS success alone.

Starting is persisted before dispatch. A lost start response is blocked rather than automatically dispatched again. Running jobs are polled after restart; temporary polling/HTTP errors remain running only within the deadline. Failed/cancelled jobs never succeed. A locally rejected preparation with no job may be prepared again. A dispatch with a job ID is never cleared automatically. Preserve receipts/checkpoints when reconciling ambiguous outcomes.

## Dedicated cloud target: AC-1 through AC-5

There is currently **no approved connected target** supplied with this change. Do not use operational app `d4hkkg7dty2du`. The host must obtain independently audited dedicated resources and a host approval record before enabling a profile. App or branch names and environment variables are not isolation evidence.

Use a separate Orchestrator dataRoot and operator port. Place its host-owned `eco-runtime.json` outside every worker's approved edit paths. The runtime accepts exactly one target profile; `targetApp` must match its profile key. For `inventory_web`/`ec`/`zaico`, the profile declares its own required independent verification commands, bounded allowedPaths, explicit Codex phase model/effort, QA steps and existing Playwright installation. QA steps must navigate, reload and end with a screenshot. The following staging fields are mandatory:

- `mode: real-staging`, `framework: nextjs`, `enabled: true`, `isolatedDataConfirmed: true`.
- `service`, `environment`, `stagingId`, `accountId`, `region`, `appId`, `appName`, `branch`, `profile`, `repository`, `environmentId`, `dataScopeId`, `qaUrl`, `revisionPath`.
- Repository is an approved HTTPS GitHub URL. Branch must match the existing staging/stage/preview policy. `qaUrl` is the exact HTTPS Amplify branch origin `https://BRANCH.APP.amplifyapp.com/`; profile qaUrl matches it and allowedDomains contains only that hostname. Production environment names are rejected.
- `hostApproval.approved: true`, `purpose: verification-only`, nonempty `approvalId`, and exact copies of service/account/region/app/name/branch/repository/environment/stagingId/environmentId/dataScopeId/qaUrl.
- `hostApproval.isolation`: `dedicated: true`, `productionDataAccess: false`, nonempty `verifiedBy`, `evidenceId`, dedicated `resourceIds`, `operationalResourceIds`, `operationalDataScopeIds`. Lists must be populated and disjoint from the target resources/data scope. Host approval records the audit of actual resources/access, not an operator's naming convention.
- Optional exact approved role ARNs: `hostApproval.iamServiceRoleArn`, `computeRoleArn`, and `branchRoles` with those keys. Absent means no role is allowed. The host must audit these roles' resource access before approval. This adapter neither reads policies nor creates/changes roles.

Preflight checks AWS's actual account/region/app ARN, app name/repository, WEB_COMPUTE platform, `Next.js - SSR` framework, DEVELOPMENT branch, automatic builds disabled, no backend binding, exact approved roles and no backend-changing build spec. The only permitted app environment variables are `BELLO_ENVIRONMENT_ID`, `BELLO_DATA_SCOPE_ID`, `BELLO_ISOLATION_EVIDENCE_ID` matching the approval; branch environment overrides must be empty. These markers corroborate the audited approval; they do not establish isolation themselves. Missing/changed/denied targets fail closed. Fresh Next.js capability probes are bound to the full profile hash; an old static/photo probe cannot claim this target is connected.

Host execution needs only scoped Amplify `GetApp`, `GetBranch`, `StartJob`, `GetJob`, read access to the approved GitHub branch and an existing explicitly named AWS CLI profile. The host publishes a reviewed commit separately if authorized. No resource creation/update, IAM/S3/Cognito changes, migrations or operational data access are granted by this adapter. Account/profile/network failures remain failures and do not justify model escalation or API billing.

## Real Next.js revision API and browser evidence

The actual Next.js application/build must expose the configured same-origin `revisionPath`, e.g. `/api/revision`, returning `application/json` with exactly matching identifiers:

```json
{
  "revision": "<40-character implementation commit>",
  "deploymentId": "<Amplify job ID or local host instance deployment ID>",
  "environmentId": "<approved dedicated environment>",
  "dataScopeId": "<approved dedicated fixture/data scope>",
  "verificationFingerprint": "<64-character verified source fingerprint>"
}
```

The response describes the source **actually built and served**. The server must not echo request/query/header values as its identity. On Amplify the existing host-approved build must derive revision/job ID from its real build metadata and compute the same clean source fingerprint used by independent verification. Agree on checkout normalization (including line endings) so the fingerprint is reproducible. Do not inject secrets or modify operational app configuration to implement this contract. This change does not invent a revision endpoint inside the out-of-scope analysis application; a target without the endpoint stays blocked.

HTTP verification uses no-store/no-cache, refuses redirects, requires JSON, caps the body at 8 KiB, and checks revision/deployment/environment/dataScope/fingerprint. HTML bytes are not a Next.js identity. A `next_http` or `local_next_http` checkpoint is written only after matching real HTTP. Browser QA rechecks HTTP before and after capture and on reconciliation. Its manifest binds screenshots, DOM/network observations and the operation/run to the HTTP build identity/fingerprint; a cached manifest for another build is rejected. A successful receipt without these identifiers cannot set Next.js healthPassed.

Before implementation delivery, initial QA records NOT_RUN/BLOCKED baseline criteria, without fabricating a reachable baseline or rendering a static page. Final QA requires actual browser evidence. This is separate from the existing photo/store local evidence flow.

## Local Next.js host contract: AC-6

There is **no implicit local sandbox**. A host-owned Windows MXC adapter has been implemented and exercised separately with a production Next fixture and an offline real browser. It must be pinned together with an audited immutable application bundle for each exact source revision. An ordinary node/next process or environment markers alone remain insufficient. The operational app is never a fallback.

The local staging configuration requires:

- `mode: local-next-isolated`, `framework: nextjs`, `service: inventory_web`, enabled and isolatedDataConfirmed true.
- Literal loopback `hostname: 127.0.0.1` or `[::1]`, dedicated integer `port` in 1024–65535, exact `http://HOST:PORT/` qaUrl and an explicit revisionPath. No hostname resolution, LAN binding or cloud fallback is allowed. Cloud account/app/repository/profile/branch settings must be absent.
- Absolute dedicated `dataRoot`, nonempty `operationalDataRoots`, `operationalPorts`, `operationalDataScopeIds`, with no overlap. The host creates/checks those directories; canonical path overlap through symlinks/junctions is rejected before starting. Include the existing Photo Station dataRoot/port in the operational inventory, without changing them.
- `dataAdapter: {kind: fixture|local-adapter, id: ...}`, `executionPolicyId`, `environmentId`, `dataScopeId`, absolute `hostAdapterPath`, SHA-256 `hostAdapterSha256`, and an optional exact `hostBundle: {descriptorPath, sha256}`. The native MXC adapter requires the bundle.
- `hostApproval: {approved: true, approvalId: ...}` plus exact copies of hostname/port/dataRoot/hostAdapterPath/hostAdapterSha256/executionPolicyId/environmentId/dataScopeId/qaUrl/revisionPath/dataAdapter/operationalDataRoots/operationalPorts/operationalDataScopeIds/hostBundle.
- Eco settings explicitly set `stagingMode: local-next-isolated`, qaUrl and loopback allowedDomains. Policy allows loopback HTTP only when a fresh connected host capability reports this exact mode/URL. Other modes retain HTTPS-only QA.

The administrator-owned pinned **CJS module** must reside outside worker repositories and writable dataRoot and export these asynchronous operations. It is trusted host code, not an application-supplied adapter. Its file digest is checked before loading; missing, altered or incomplete modules remain unconnected.

| operation | request / required behavior |
| --- | --- |
| `preflight` | `{settings}`; test actual OS sandbox/firewall/mount policy, canonical roots, reserved port, installed Next runtime and dedicated fixture/local adapter; return enforcement proof |
| `runVerification` | `{settings, command}`; execute each host-approved independent verification command under the same enforced isolation, honor timeout/shouldStop, return normal runProcess result plus `isolation` proof |
| `captureQaSession` + `probeBrowser` | Preferred isolated-host browser route. Return bounded real browser observations/screenshots plus matching enforcement proof. The native MXC host uses this route. A host may instead implement `launchBrowser`; there is no ambient launch fallback. |
| `start` | `{taskId, source, workDir, settings}`; idempotently record task ownership, build/run the actual committed Next page/API with fixture/local adapter; return process receipt |
| `inspect` | `{taskId, process, settings}`; obtain actual process identity and port owner, not just process.kill(pid,0); return matching identifiers, running true and fresh enforcement proof |
| `stop` | `{taskId, process, settings}`; resolve a lost response by task ID, verify PID+instance ownership, terminate the owned process tree/sandbox and confirm port closure; return `{stopped: true, portClosed: true}`; be idempotent |

Enforcement proof shape (nonempty evidence IDs reference the host's actual measurements):

```text
executionPolicyId, enforcementId, dataRoot, hostname, port
network: {outbound: "deny", loopback: "HOST:PORT", evidenceId}
filesystem: {productionConfig: "deny", operationalData: "deny", evidenceId}
credentials: {inheritance: "deny", defaultAwsFiles: "deny", metadata: "deny", evidenceId}
runtime: {framework: "nextjs", dataAdapterId, dataAdapterKind}
```

Process receipts include revision/deploymentId/environmentId/dataScopeId/verificationFingerprint, actual pid/port/hostname, stable nonempty instanceId and isolation proof. Inspect must match every field and protect against PID reuse. HTTP and process inspection must agree before/after verification. Independent commands are dispatched through the same adapter; a stripped environment is only defense in depth. Repository source names are checked before fingerprinting: dotenv, production amplify_outputs.json and AWS credential paths require a sanitized fixture worktree instead. Contents of forbidden files are never read by this check. The host sandbox must also deny nested/ignored configuration, other repositories, user home/AWS defaults, metadata endpoints and all outbound traffic; permit only the approved fixture and loopback origin. Build outputs/caches belong in the dedicated writable sandbox, preserving the clean committed source.

No generic OS sandbox is provisioned by this patch. The host must implement/audit that privileged boundary (for example a suitably restricted container/VM or equivalent policy) before supplying its module. A module that merely reports the proof fields without enforcement violates the contract. Real runtime/app/sandbox verification remains host work.

Local Playwright is launched through the trusted host adapter with enforcement proof; an ambient browser launch is not accepted. It uses a fresh context with service workers blocked. Local QA intercepts HTTP and WebSocket requests, allows only the exact loopback origin, blocks WebSockets, and refuses browser versions without WebSocket interception. The host sandbox enforces browser background traffic as well as server/build isolation; page routing is defense in depth.

## Host verification and evidence limits

The initial implementation-phase tests were deferred to the host. Host execution subsequently passed all 361 tests, including cancellation/start races, actual subprocess HTTP/port cleanup, receipt rotation, stale capability pins, cloud disconnect, capture wiring, and managed freeze/bundle ordering. See `artifacts/orchestrator-repair-20261114/host-managed-order-final-tests.log` and `residual-independent-review.txt`. Earlier failure and timeout records are retained separately.

For a dirty scoped worker revision, the host now commits only the reviewed allowed paths before definitive local verification. A missing or different pinned bundle leaves the run in WAITING_APPROVAL at TESTING and exposes `pendingLocalBundle: {commit, fingerprint, plan}` through the existing authenticated run API. The operator builds/curates that exact source, prepares its bundle descriptor, mirrors the pin in the host profile/approval, and resumes the same run with its current version and an idempotency key. No passing test is recorded at the bundle handoff. Resume checks the source tuple again and runs independent commands inside MXC before delivery. An occupied preview is stopped through its original owned receipt before new port readiness is checked. The managed regression exercises this ordering with an HTTP fixture; actual MXC feature evidence is a separate artifact.

The actual host is recorded in `artifacts/orchestrator-repair-20261114/mxc-host`. Its synthetic smoke test passed strict MXC filesystem, credentials/environment and outbound network canaries; independent pinned command execution; real Next production page/API/assets; offline Chromium hydration/click/screenshot; identity checks; ownership/duplicate-launch rejection; and confirmed stop/port closure. Those observations prove the synthetic fixture only. Each feature needs its own audited source/build and browser record.

Native MXC denies TCP, including loopback, to the application and browser. A bounded stdio bridge serves the approved host-only loopback preview, while the Next server uses an internal named pipe. The reviewed host forbids arbitrary paths, origin changes and mutations. Runtime bundles contain regular hashed files, fresh homes and no production outputs, dotenv, AWS files, linked dependencies or inherited credentials. Development compilation is not supported under this strict profile; the host exports an independently checked production build from the exact reviewed source. Its provenance and source/plan hashes must be recorded.

Full application schema/IAM/index deployment and authenticated AWS integration are separate staging acceptance checks. The cloud adapter remains disconnected; do not label local fixture evidence as deployed cloud integration. The worktree metadata was restored by the host before tests; initial intake failures are historical, not an unresolved Git state.

## Stop, reconciliation and rollback

1. Pause the dedicated Orchestrator; do not pause or reconfigure the operational Photo Station service. Existing operator authentication and approval controls remain required.
2. Runtime shutdown awaits in-flight work, then calls the local adapter stop for all owned receipts, including ambiguous starts. Failed/cancelled eco runs request task-scoped cleanup. For an interrupted response use taskId ownership in the host adapter; never kill a guessed or reused PID. A stopped local receipt becomes blocked/historical and cannot pass live QA.
3. For cloud starting/blocked outcomes inspect the **saved** approved app/branch/job receipt using authorized host tools before any retry. Do not create a second release merely because a response was lost. No AWS stop/delete API is automatically issued by this change.
4. Preserve receipts, checkpoints and browser evidence; disable the new dedicated profile. Revert only this task's approved source changes and dedicated host configuration. Remove/stop only this task's sandbox/fixture through the host's approved procedure. Never overwrite the original photo configuration, DB or queue.
5. Rollback of a cloud revision is a separately verified host action against the dedicated target; never redirect this adapter to the operational app. Rollback needs a fresh receipt for the intended clean commit and independent verification, not relabeling old HTTP evidence.
