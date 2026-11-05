# Betterloop code review and implementation handoff

Reviewed November 4, 2026. Audience: the owner and an implementation LLM working in this repository.

**Recommendation: repair the priority-one items before inviting the full friend group.** The core architecture is appropriate for this scale, and normal saving, resubmission, photo upload and publication work. The remaining risks are concentrated in draft recovery, scheduling and the distinction between a saved draft and a submitted update. Reminder frequency is not configurable yet.

This review adds tests, CI and a public source snapshot. It does not implement the product repairs below or redeploy the running application. Each finding identifies observed behavior, a bounded repair and acceptance criteria. R2, R3, R4 and R6 have executable reproductions marked as expected failures; these annotations must be removed when fixed.

## Architecture assessment

Keep the single deployable application: React frontend, Hono HTTP routes, D1 for transactional state, private R2 for photos and exports, and a bounded Cron/outbox worker. Five groups with twenty members each do not require microservices, a general job framework, an ORM migration or a new state-management stack.

The strongest existing separations are browser photo preparation versus private server storage; calendar calculation versus scheduling; submitted snapshots versus editable drafts; and durable outbox intent versus external email delivery. Authorization is centralized, and database constraints protect critical state transitions. Export and cleanup complexity has a purpose: references must survive interrupted R2 operations and privacy deletions. Preserve those protections during refactoring.

The weakest separation is the frontend: `src/main.tsx` contains routing, authentication screens, groups, questions, members, the entire composer and the reader in 1,617 lines. Backend feature files are more focused, but several mix HTTP handling, SQL transitions, policy and side effects. `server/index.ts` also contains operator/dev routes and Cron orchestration. See R8 for a small extraction plan.

| Concern | Current authority | Preserve |
| --- | --- | --- |
| Authentication and access | `server/security.ts`, `server/auth.ts`, memberships | Hashed sessions, explicit email confirmation, CSRF and per-group authorization |
| Drafts and submissions | `server/issues.ts`, contributions | Revision checks; only `submitted_json` enters publication |
| Publication | `server/scheduler.ts`, publications | Immutable issue snapshots; unique publication/outbox identities |
| Delivery | `server/mail.ts`, email_outbox | Claims, eligibility rechecks, bounded retries and uncertain-send handling |
| Photos | `src/photo.ts`, `server/photos.ts`, private R2 | Browser resizing; metadata stripping; membership checks on every read |
| Lifecycle | `server/account.ts`, `server/privacy.ts`, `server/cleanup.ts` | Immediate access revocation plus resumable content cleanup |
| Exports and backups | `server/exports.ts`, `scripts/` | Reference pins, encrypted off-app recovery and isolated restore |

## Findings and repair acceptance criteria

### R1 Configurable reminders are missing

**P1, required feature gap.** `server/scheduler.ts:125`, `server/issues.ts:158` and `server/issues.ts:359` hardcode one reminder at deadline minus 48 hours. `src/owner.tsx:264` offers an individual on/off checkbox, not frequency or timing. The weekly/fortnightly/monthly dropdown controls newsletter cadence only. Short manually opened issues can receive an opening and a reminder on adjacent ticks because their reminder time is already in the past.

Implement a small group-level reminder policy, such as zero to three offsets before the deadline, defaulting to the current `[48 hours]`. Retain individual opt-out. Snapshot the policy into each issue so editing future group settings does not silently change an open issue. Use explicit reminder slots and a unique delivery key containing issue, slot, deadline version and member. A small `issue_reminders` table is enough; a generic scheduling engine is unnecessary. Preserve already-sent markers during migration. Define how a deadline extension replaces future slots without sending catch-up bursts.

Acceptance: owner/admin can configure none, one or multiple reminders; ordinary members can only opt themselves out. Before/at/after each due time is tested. Submitted, removed, suppressed and opted-out recipients are excluded at send time. Concurrent ticks do not duplicate a slot. Changes to deadlines and preference, a late joiner, withdrawal after an earlier reminder, downtime spanning several slots and a collection window shorter than the first offset all have explicit behavior. No overdue reminder is sent after closure. Show the next reminder and group timezone in settings.

Existing evidence: `tests/review-flows.test.ts` verifies no early reminder, one scheduled reminder and suppression after deadline; `tests/lifecycle.test.ts` and `tests/replay-lifecycle.test.ts` cover submission/opt-out/removal and deadline extensions. They validate the existing single-reminder policy, not the proposed configuration.

### R2 Unsaved drafts can disappear when a phone closes the page

**P1, reproduced.** `src/main.tsx:1060–1186` keeps unsaved text in React state and a ref. It saves after one second of idle time or on blur, and warns with `beforeunload`. There is no persistent local recovery record. The browser test saves an initial answer, aborts subsequent save requests, writes more text and forcibly closes the page. Reopening in the same browser restores only the earlier server draft.

Add a small draft-recovery module using IndexedDB or an equivalent bounded local store, keyed by authenticated user, group and issue. Store text, photo IDs, base server revision, generation and time; do not store session credentials or automatically persist original image files. Keep D1 authoritative. Recover pending local changes explicitly when the base revision conflicts, and clear only the generation acknowledged by the server. Retain recoverable text after deadline in read-only/copy form. Scope cleanup to logout, account changes and a documented short retention period. A `visibilitychange` save can help but cannot replace durable local recovery: mobile unload events are unreliable. [MDN beforeunload guidance](https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event).

Acceptance: survive refresh, route changes, forced close, offline edits and session expiry; never show one account's local draft to another; avoid stale-tab overwrites; preserve a newer local generation when an older save completes. Keep explicit submission separate from autosave. Remove the R2 expected-failure annotation in `e2e/review.spec.ts` after the reproduction passes.

### R3 One group with no questions starves other groups

**P1, reproduced.** `server/scheduler.ts:77–107` selects only the earliest eligible group. If it has no selected questions, `plan()` returns without changing its candidacy. The next tick selects the same group again. Deselecting every question is allowed by `server/groups.ts:285–306`. A test with two due groups and repeated ticks creates no issue for the healthy second group.

Filter planner candidates to groups with selected questions, or examine a small bounded candidate set and record why a group cannot open. Make the blocked state visible to its host. Do not quietly choose questions for the group or spin through unbounded records. An `EXISTS` predicate plus a host-facing explanation is a sufficient first repair.

Acceptance: a blocked earliest group cannot delay any other eligible group; reselecting a question makes it eligible again; concurrent planners still create only one issue. Keep the query bounded. Remove `.fails` from the R3 test in `tests/review-flows.test.ts`.

### R4 Losing a save response traps the composer on a stale revision

**P1, reproduced.** `src/main.tsx:1130–1166` updates its revision only after the response arrives. The browser test lets a PUT commit, then drops the response. The UI keeps its old revision. Clicking “Retry saving” receives 409 indefinitely, even though the write succeeded. The last saved text is safe on D1, but continuing requires manual copy/reload and can lose later typing.

Reconcile an uncertain write using a stable mutation ID per snapshot, or fetch and compare the server snapshot before retrying. A content match may acknowledge that snapshot and advance its revision; a different snapshot must remain a real conflict. Preserve edits typed after the uncertain request. Do not automatically overwrite a newer remote revision to make retry succeed.

Acceptance: lost response after commit, failure before commit, new typing during the failure, simultaneous second-tab edits and deadline closure all preserve user text and converge honestly. Apply the same reasoning to a lost submit response. Remove the R4 expected-failure annotation after repairing it.

### R5 Saved edits after submission need a clear resubmission state

**P1, usability risk confirmed by code and flow tests.** The backend deliberately leaves `submitted_json` unchanged when a draft is edited (`server/issues.ts:222–320`). This is correct, but the composer always labels the draft “Saved” and “Only you can see this draft” (`src/main.tsx:1201–1215`). It does not clearly explain that an earlier submitted copy will publish unless the edited copy is submitted again. Group home still says the update is submitted. “View your update” opens an editable composer, which adds to the ambiguity.

Show distinct states: draft saved, submitted at a specific time, and edits saved but not yet submitted. After edits diverge from the submitted snapshot, use a clear “Submit changes” action and a notice that the previous submission remains scheduled. Expose a preview of the currently submitted copy. When closing occurs, say which copy was included. Ensure submit/withdraw actions are disabled during conflicting saves and have their own pending state.

Acceptance: submit A, save B, leave and return: the UI explicitly says A will publish. Resubmit B and show its confirmation. At deadline, publication contains B only if it was resubmitted. Preserve the existing test that unsubmitted edits remain private.

### R6 Long user content breaks the mobile layout

**P2, reproduced.** An allowed 80-character unbroken group name makes a 320-pixel group page 2,682 pixels wide. General headings and the reader masthead lack the wrapping protection already applied to home cards. See `src/styles.css:42–54`, `src/styles.css:389` and `docs/evidence/mobile-long-name.png`.

Apply wrapping and minimum-width constraints to user-generated headings, questions, captions, contributor names and grid/flex children. Make photo columns responsive (`minmax(0, 1fr)`); consider one column for composition on narrow phones so captions have usable width. Do not solve clipping by hiding page overflow, since that conceals content.

Acceptance: 320/390/768/1280 widths, 200% zoom, long words/URLs, maximum-length captions and member names, plus keyboard focus. The R6 test must pass without an expected-failure annotation. Retain the normal-layout and accessibility checks.

### R7 Maintenance failures can delay all email work

**P2, code-path finding; no production outage claimed.** `server/index.ts:331–335` awaits scheduling, exports, cleanup and signup before processing the outbox inside one try/catch. An uncaught R2 cleanup failure can prevent unrelated login, reminder and publication mail from running that tick. Repeated failure can consume short login validity or the reminder window. Individual helpers already catch some errors, but this outer coupling remains.

Run independent bounded stages behind explicit error boundaries and record per-stage health. Consider processing urgent outbox work before best-effort cleanup. Retain access checks, cleanup reference guards and idempotent writes; do not indiscriminately parallelize dependent work. Keep work and database-query budgets bounded.

Acceptance: inject a cleanup-only R2 failure and prove eligible login/reminder work still progresses while cleanup is visibly failed and retryable. Verify that a publication failure cannot send a nonexistent publication. Add a scheduled-handler regression rather than testing only a helper in isolation.

### R8 Extract feature modules without adding infrastructure

**P2, maintainability.** Move `App`, route parsing and navigation guards into an app shell. Extract auth screens, group screens, `Composer`, `Reader` and a `useDraft` hook. The hook should own save serialization, conflict/recovery state and submission state; JSX should own rendering. Move shared API DTOs out of frontend imports from `server/types.ts`, leaving database row/environment types on the server.

On the backend, first extract operator/dev routes from `server/index.ts`, then keep each feature's transaction helpers close to that feature. Centralize duplicated issue-open/reminder policy used by manual creation and recurring planning. `server/issues.ts` currently attempts an insert/upsert and then a separate update for nonzero revisions; two explicit revision-zero/update branches would be easier to reason about. Avoid wrapping every SQL call in a generic repository interface. Extract only business transitions that are duplicated or require focused tests.

Acceptance: refactor in small commits after the behavior repairs; all existing access, race, deletion, reminder and draft tests continue passing. No new deployment unit, ORM or global state framework is needed. A new reader should find the compose flow without opening the routing file.

### R9 Finish photo and reading polish on real phones

**P2, mixed verified behavior and unverified device support.** JPEG and PNG preparation and storage worked. A 13,212,191-byte PNG became a 1,032,976-byte JPEG at 1600 × 1067. The file input advertises HEIC/HEIF (`src/main.tsx:1364`), while `src/photo.ts:11` depends on browser `createImageBitmap` support. Unsupported images already receive a useful error; this review does not establish native iPhone HEIC support.

Test real camera-roll selection, EXIF rotation and a large image in Safari on a phone. Only advertise formats the supported browser path can handle, or provide an intentional conversion fallback. Show preparation/upload progress. Include captions in the pre-submit review: the current review branch hides caption inputs without rendering their caption text. Consider a larger private photo view in the reader. Hide empty question/shout-out/good-thing blocks or use a deliberate empty state; the sample letter currently contains empty tinted panels. Unify field focus styling with the plum button focus rather than relying on a browser-blue textarea outline.

Acceptance: readable photo previews/captions at narrow widths, three-photo limit, replace/remove/resubmit cycles, failed upload retaining text, file >20 MiB, malformed files, transparent PNG, portrait rotation, and native phone picker. Keep the real-image browser tests; the older minimal JPEG byte fixtures test server structure but do not prove browser decoding.

### R10 Make public configuration and operations portable

**P2, partially addressed for publication.** This public snapshot replaces the embedded account dashboard URL, operator display-name default and hardcoded backup account with neutral configuration. The production Wrangler file and generated launch-agent plist are excluded. `CLOUDFLARE_ACCOUNT_ID` is now required by the R2 backup runner. The existing private deployment and weekly backup installation were not changed.

Further work: use a single explicit deployment/config source for backup resource selection; pass the configured bucket and environment into the generated launch agent rather than retaining its fixed bucket name. Wrangler OAuth fallback is macOS-specific even though generic backup paths support other platforms. Prefer an explicit runner token or a documented portable credential resolver. Keep restore reconciliation and the independent recovery-key requirement. Add automated backup freshness alerting only when its notification channel is chosen.

Acceptance: a fresh clone can run all tests without credentials; a deployment template cannot silently target someone else's account; backup configuration tests cover a non-default account/bucket and missing credentials; generated machine paths remain ignored. Do not move backups or rotate encryption keys during a UI refactor.

## What was tested

The original reviewed source passed its 76-test baseline, TypeScript, formatting and production build. The public snapshot adds four backend review cases and eight Chromium browser cases. The final local suite has **79 ordinary backend passes and one expected backend failure**, plus **five ordinary browser passes and three expected browser failures**. Expected failures are proof of known defects, not successful product behavior.

| Flow | Result and evidence | Limit |
| --- | --- | --- |
| Reminders before deadline | Pre-window exclusion, one reminder and no post-deadline send; existing tests cover opt-out/submission/removal/extensions | Configuration absent; email captured locally, not delivered to a real inbox |
| Two sample submissions | Two synthetic members uploaded real decodable JPEG/PNG, submitted and appeared in one published issue | Isolated workerd/D1/R2, not the live friend group |
| Upload downsizing | 3200 × 1800 JPEG → 1600 × 900, 28,590 bytes; 1800 × 2400 PNG → 1200 × 1600, 26,920 bytes; separate 13.2 MB input test passed | Browser Chromium; native phone picker and HEIC remain manual |
| Photo privacy | Other member denied before publication, allowed afterwards; anonymous request 401 | No new production penetration test |
| Return to a partial draft | Reload and a freshly authenticated second browser session restored text and caption | Only acknowledged server saves are durable today |
| Edit after submission | Saved edits remained private, explicit resubmission changed the published copy | Needs clear UI state R5 |
| Deadline and withdrawal | Late save/submit/withdraw rejected; withdrawal retained draft and excluded it from publication | New boundary tests use controlled D1 times |
| Slow saves and conflicts | Typing during a save persisted; stale second-tab save returned 409 and retained its visible text | Lost acknowledgement remains R4 |
| Email links | Opening/reminder mail uses a stable issue URL; app can sign in and return there; auth tests reject replay of one-time tokens | A used/expired magic sign-in token cannot be reused; use the issue URL or request fresh sign-in |
| Mobile layout | Normal composer/settings fit 320/390/768/1280; composer has zero axe WCAG 2/2.1 A/AA violations | Long name overflow reproduced; automated axe is not a screen-reader session |
| Publication rendering | Browser reader and captured email inspected with two contributions and two photos | Photos are private web links in email; real Gmail/Apple Mail rendering not tested here |
| Persistence and recovery | D1 server drafts survive new browser sessions; existing export/restore and cleanup suite passes | No new live backup restore or real phone force-quit test in this review |

Run `npm test` and `npm run test:e2e` to reproduce. CI runs formatting, type checking, backend tests, build and the browser suite on every push/PR with no production credentials. It retains synthetic screenshots/traces. Known-failure annotations are intentionally narrow and must be removed as repairs land; a green CI check is not evidence all review findings are fixed.

Visual evidence: [mobile composer](evidence/mobile-composer.png), [mobile published letter](evidence/mobile-reader.png), [desktop published letter](evidence/desktop-reader.png), [mobile settings](evidence/mobile-settings.png), [captured email rendering](evidence/mobile-email.png), [sample email HTML](evidence/sample-newsletter.html), [sample data checks](evidence/sample-result.json), [large-upload measurements](evidence/large-upload-result.json).

The browser bridge runs the real React code against an isolated compiled Worker with real local D1/R2 bindings. It uses captured mail and synthetic verified identities. This is broader than a mocked frontend, but it does not exercise Cloudflare's deployed network, real email delivery, or mobile Safari. The existing production application was not altered during this review.

## Implementation order for the next LLM

1. Read this document, the tests and schema before editing. Reproduce R2/R3/R4/R6; inspect their expected-failure annotations. Keep the public deployment template separate from private resource configuration.
2. Fix R3 and R4 first, in independent small changes. Add durable draft recovery and clear submission states together (R2/R5).
3. Implement R1 with an additive migration, issue-policy snapshot and delivery-deduplication tests. Preserve existing sent-history semantics. Do not rewrite old migrations against the live database.
4. Repair R6 and photo/review polish, then perform the small module extractions in R8. Address R7 with failure-injection coverage. Follow R10 before relocating operations.
5. Remove the corresponding expected-failure annotations as defects are repaired. Run the full CI checks, compare mobile screenshots and preserve all authorization/lifecycle tests. Do not declare completion by deleting or weakening a reproducer.
6. Before deploying, review the change set and migration against the actual current production configuration; take and verify the configured backup. No paid plan change is authorized by this review. No new services are required for the proposed first repairs.
7. Before broad invitations, exercise one consenting new member's actual email verification/sign-in, a real phone photo upload, return-to-draft, edit/resubmit and an actual reminder/published email. Inspect spam placement and mobile mail rendering. Then observe two small group cycles and account-wide usage.

Suggested instruction to the implementation LLM: “Implement R3, R4, R2, R5 and R1 from `docs/CODE_REVIEW.md` in that order, retaining the modular single-Worker architecture and current privacy rules. Use the provided regressions as acceptance criteria, add missing reminder/recovery cases, and remove expected-failure annotations only when fixed. Then repair R6 and do the scoped extractions in R8. Report remaining real-device/email checks separately from automated evidence.”
