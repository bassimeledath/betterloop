# Betterloop review repairs

The implementation addresses the review's software findings while retaining one Worker, D1 and private R2 storage. The original review is historical context. Its four defect reproductions now run without expected-failure annotations.

| Review item | Implementation |
| --- | --- |
| R1 Reminder timing | Group administrators configure zero to three distinct reminder offsets, from 1 to 168 hours, under group settings. New issues snapshot the policy. Existing issues retain their schedule. Each slot has a unique outbox identity; deadline extensions reset the remaining schedule against the new deadline and skip old queued messages. After downtime only the most recent due slot is queued. Individual opt-out, submission, removal, suppression and closure checks remain enforced. |
| R2 Draft recovery | Local recovery stores text and photo references, scoped by account/group/issue, with seven-day expiry on access. Original image files and credentials are excluded. Acknowledged saves clear the local copy; conflicting server changes require copying/reloading rather than overwriting. Logout and account deletion clear local recovery. The published issue offers access to the user's closed draft for recovery/copying. |
| R3 Planner isolation | Groups without selected questions are excluded from planner selection and show a blocked-state explanation to members. Other groups progress normally. |
| R4 Uncertain save | Retry reads the server revision. If the previous write committed and its content matches, it acknowledges that snapshot; if no revision advanced, it retries safely. Different remote edits remain conflicts. Subsequent typing is retained. Submit also reconciles an ambiguous response against the submitted snapshot. |
| R5 Submission state | Composer distinguishes a submitted copy from private edits and labels resubmission “Submit changes.” The previous submitted copy remains authoritative until resubmission. Submit/withdraw controls respect pending work. |
| R6 Layout | Long headings wrap, grid/flex children can shrink, mobile composition photos use one column, and form focus uses the plum theme. The original 320-pixel overflow reproduction now fits. |
| R7 Cron resilience | Bounded stages have independent error boundaries and individual health records. Mail runs before export/cleanup work. An injected cleanup R2 failure records failure while eligible mail still sends. |
| R8 Modules | Authentication screens, group screens, composer, reader, shared DTOs, operator routes, Cron orchestration, reminder policy and draft storage have dedicated modules. The routing file no longer contains composition/reading logic. No new service or framework was introduced. |
| R9 Photo polish | Review shows captions; transparent input composites onto paper; reader photos open full size through the authenticated asset endpoint. Empty answer/shout-out/good-thing panels are omitted. Unsupported HEIC is no longer advertised by the file picker. Preparation/saving has a visible state. |
| R10 Operations | Backup installation reads account/bucket from private deployment config and passes the account to the runner. Non-macOS runners require an explicit API token or credential file path instead of looking in a macOS credential directory. Generated plists remain ignored. Existing recovery keys and installed backup jobs are preserved. |

## Reminder semantics

The default remains one reminder 48 hours before deadline. Offsets apply to future issues; extending an active issue uses its own saved policy. A short manually opened issue whose reminder time is already past sends one catch-up reminder on a subsequent tick, provided the deadline has not passed. Multiple missed slots are coalesced. A new or withdrawn member can receive remaining future slots, but completed slots are not reopened. Delivery is subject to the existing bounded queue and provider availability, not exact-to-the-second delivery.

Migration `0010_reminder_policy.sql` is additive. It preserves already-reminded issues and rekeys existing reminder jobs to the slot format, avoiding a second logical delivery after migration. Back up before applying it to production.

## Verification

The backend suite covers 84 cases, including new multiple/disabled/coalesced reminder tests and pipeline failure injection. The browser suite covers nine cases, including lost responses both before and after commit, offline force-close recovery, two real image submissions, resubmission, publication, private access and responsive layout. TypeScript, formatting and the production build are required in CI. See the repository Actions run for current results.

The tests use real isolated workerd/D1/R2 bindings and captured mail. They do not send email to friends or exercise mobile Safari. Native camera-roll selection, image orientation on actual phones, screen-reader use and Gmail/Apple Mail rendering remain human pilot checks. No paid plan upgrade is part of these repairs.

Local recovery is a convenience copy on the current browser, not a replacement for acknowledged D1 storage. If browser storage is unavailable, the composer reports that limitation. Different-account keys cannot be rendered into one another's composer. For a real multi-device conflict, copy local text before choosing the saved server version.
