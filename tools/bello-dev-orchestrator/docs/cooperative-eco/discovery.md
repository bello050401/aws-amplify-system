# Discovery: cooperative eco v1

Baseline: f133ad3, branch claude/inventory-management-system-5vbvc7. User change docs/health/final-tests.md remains untouched. No AGENTS.md found in repository or checked parent directories.

|Area|Decision|Existing implementation|
|---|---|---|
|Tasks, state history, TODO|Reuse|Repo, Store, Orchestrator, TodoManager|
|Worker shutdown and process lock|Reuse|SingleInstanceLock, stop.flag, drain-before-close|
|Code execution|Reuse|ClaudeRunner / CodexRunner, dedicated worktrees|
|Tests|Extend|IndependentVerifier, content fingerprints, persisted evidence|
|Staging|Reuse|StagingDelivery / AmplifyStaticDelivery, saved job and HTTP hash|
|Settings/API/UI|Extend|local Dashboard, CSRF header, LAN token, settings panel|
|Cooperative phase state/artifacts/cache|New extension|Versioned run metadata using the same SQLite Store|
|GPT browser driver|Not connected|Desktop CUA is available in this interactive task, not callable by the persistent worker|
|Production dispatcher|Unavailable by design|No production action will be fabricated or enabled|

Preservation: C:/Users/win/Documents/Codex/bello-eco-preservation-20260916/before.sqlite and state.json. Worktree: C:/Users/win/Documents/Codex/bello-cooperative-eco. No operational DB migration or service restart authorized by this specification's section16; implementation/testing uses disposable DB or backup copy only.

Plan: explicit opt-in schema installation, versioned config and run snapshots, contracts, leases/CAS, bounded repair/budgets, exact cache keys, adapter availability and UI. Reuse existing runners and deployment guards rather than replacing them. Unavailable browser/model capabilities remain BLOCKED. Run settings do not change existing tasks or resume paused work. New settings are defaults only for newly requested runs.

Tests: legacy regression, state/repair/lease/approval/cache/contracts and API/UI using isolated dataRoot. Distinguish mocked driver integration from real browser QA and real Claude/staging E2E.

Rollback: disable development feature; old code ignores additive eco_* tables. No down migration, deletion or resetting user task state. Apply operational DB schema only after specific approval; keep backup and compare counts/history/pause before and after.
