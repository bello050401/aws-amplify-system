# Sale desktop jobs

Task: `task_db1341c92ca36cdb23`. This queue stores desktop requests and authenticated
visual attestations; it is not an unattended browser host or an image recognition
service. Actual browser operation uses the approved ChatGPT/Codex desktop CUA
session. No Playwright/HTTP stock-writing adapter was introduced.

The ADMIN workbench is `/inventory/sale-candidates/desktop`; its same-origin,
session-verified API is `/api/sale-candidates/desktop-jobs`. GET pagination is
explicit (`cursor`). It can return an empty page with a continuation cursor;
desktop workers must continue until the cursor is absent. Empty application
polling performs no model call. Any separately configured app automation uses
the app's normal subscription scheduling and is not an event-triggered CUA host.

`IDENTIFY_SALE` starts from an authenticated, canonical Mercari seller-order URL.
The desktop reads the real order title/photo, selects the exact BELLO inventory,
and supplies the actual Mercari listing ID. The server confirms the selected
inventory's title/image/version and repairs missing eConveni metadata only by a
unique immutable listing ID. It then atomically stores the desktop receipt and
CAS-enriches the original still-pending candidate. This exact completed proof may
satisfy pre-sale verification while its observation is at most 30 minutes old,
the authenticated order facts remain unchanged, and its inventory version,
listing, selected image and saved attestation still agree. Otherwise a separate
`VERIFY_SALE` job binds the final snapshot before inventory mutation.

`STOCK` requests an absolute remaining quantity; zero requires a stopped listing
and quantity zero in readback. Before the external action, `start-write` requires
the title/photo/identity attestation, a live exact eConveni binding, an atomic
inventory-version guard and a lock for that Mercari listing. Its response permits
one normal-screen write, followed by fresh readback evidence. `WRITE_STARTED`
never becomes writable again, even after a lease expires. A later desktop may
claim only reconciliation. A lost completion acknowledgement reuses the saved
receipt and cannot change its evidence. Unresolved listing locks have no TTL.

Job identity remains the same across retries. Availability windows are initially
0h, then 6h, 12h and 18h; at 24h the job requires attention. A held/write-started
job is never recreated to evade this limit. Completed jobs are never dispatched
again. Causal Yahoo payment settlement may update the inventory-version and
managed stock-count title of an unstarted job, after the immutable settlement proof;
it invalidates any former lease. Started jobs remain readback-only.

Successful completion atomically marks the same owner's listing lock `RELEASED`.
A later job may acquire that released lock. Replaying an earlier completion cannot
release a later owner's lock; unknown writes and lease expiry never release it.

The same completion transaction wakes only existing ACTIVE automatic/post-sale
successor jobs by version CAS. It cannot create or revive jobs. Stale worker
saves cannot restore the six-hour delay; a completed replay does not wake a
successor again. The normal minute scheduler resumes the work. A future plan
timer is bypassed only when its first unresolved action is a READY Mercari stock
or stop action with the exact immutable completed receipt. Other actions,
uncertain states, active leases and approval/source guards remain in force.

The collapsed problem-reporting control accepts four fixed issue types under an
active ADMIN lease. Authentication and rate limits go to operational attention;
format/runtime failures go to the bounded repair intake. The existing diagnostic
receipt prevents repeated dispatch. Reporting a problem preserves all job/write
and lock state, and sends no raw page text, screenshot, order details or URL.

Expected photos include legacy JSON inventory images and authorized ready,
linked PhotoRegistration assets from their configured bucket. The screenshot
reference is separate from the expected source-photo reference. The server
records the authenticated actor, time, exact identities and comparison assertion;
it cannot independently establish that a supplied screenshot proves visual
identity. This limitation must not be presented as automatic recognition.

Verification: `node --import tsx --test lib/saleCandidates/desktopJobs.test.ts`.
These tests use memory-only storage and do not mutate live inventory or EC sites.
Deployment and an actual approved desktop session must be verified separately.
