# Deployment and operations

The public checkout contains an application and deployment template. It does not contain the existing deployment's resource identifiers or credentials. Changing this repository does not deploy it automatically; CI has read-only repository permissions and no deployment secrets.

1. Copy `wrangler.example.jsonc` to `wrangler.jsonc` (ignored by Git). Create dedicated Worker, D1 and private R2 resources, then fill in account/database IDs, bucket names, operator email, app origin, sender and a custom-domain route. Keep `EMAIL_MODE=disabled` during setup. Do not reuse another application's database or buckets.
2. Authenticate Wrangler in your own account. Apply the migrations with `npx wrangler d1 migrations apply DB --remote`. Configure `OUTBOX_KEY` through `wrangler secret put`, using a strong random value. Preserve this key on existing deployments: changing it makes stored login and shared-link ciphertext unreadable.
3. Set up email sending and verified recipients for your chosen provider/account plan. The current code uses Cloudflare's email binding and Email Routing destination verification. Automatic shared-link enrollment needs `CF_ACCOUNT_ID` and a `CF_EMAIL_TOKEN` Worker secret scoped to Email Routing Addresses Write on the intended account. The application never needs a broad deployment token.
4. Build and deploy deliberately using `npm run deploy`. Verify `/api/health`, anonymous private API denial, absent `/api/dev/*` access, Cron heartbeat and a consenting recipient's email flow. Only then enable live email. A provider-accepted message is not proof it reached an inbox.
5. Follow the review's pilot checks before inviting a full group. The source has five active groups, twenty active members per group, three photos per update, 1600-pixel/1 MiB stored photos, 20 MiB input photos and a 10 KB combined answer/caption limit. Account-wide Cloudflare allowances still apply. CI does not establish Free-plan capacity.

## Encrypted backups

`node scripts/backup.mjs create` exports D1 and referenced private photos into an encrypted backup. Keep its recovery key separately from the ciphertext. Use `--directory` and `--key-file` for explicit destinations; production backup requires your ignored deployment config and cloud credentials. `--local` uses only emulated resources.

For private R2 copies, pass `--r2 <bucket>` and set `CLOUDFLARE_ACCOUNT_ID` in the runner's environment. `CLOUDFLARE_API_TOKEN` can supply runner credentials; otherwise set `BETTERLOOP_WRANGLER_CONFIG` to an explicit credential file. On macOS the default is Wrangler’s preferences location. Tokens never belong in tracked files. See review R10 for portability work.

The macOS installer `npm run backup:install` creates a launch agent that runs weekly while the Mac is available and logged in. It reads account_id and the BACKUPS bucket from your private deployment config; it is not a cloud scheduler. Its generated plist is ignored. No scheduled backup job was moved or reinstalled as part of publishing this repo.

Use `node scripts/backup.mjs restore --file <backup-file> --destination <new-private-directory> --key-file <key>` for isolated recovery. Read `scripts/backup.mjs` for supported flags before running it. Recovery sanitization pauses groups, disables sending, removes sessions/login tokens/pending signups, closes shared links and expires exports. Reconcile deletion records and delivery history before any production recovery.

## Operational boundaries

The Cron handler runs every minute and processes bounded work. The sender claims two queued messages per production tick, prioritizes sign-in, rechecks membership/preferences/submission/deadline, and treats an ambiguous provider outcome as uncertain instead of automatically duplicating mail. The operator UI exposes queue age, failure state and backup summaries. One group with twenty recipients can require about ten ticks to drain one notification batch, longer with competing work or retries.

Keep `work/`, `.wrangler/`, `.dev.vars*`, `.env*`, backup files, recovery keys and private deployment config out of the repository. Public screenshots and email samples in `docs/evidence/` contain only generated test data.
