# Betterloop

Private group newsletters for friends, built with React, Hono, Cloudflare Workers, D1 and private R2 storage. Members answer questions, add photos, save drafts over multiple sittings, and submit a snapshot for the next group letter.

**Start with [the repair notes](docs/REPAIRS.md).** The original [code review](docs/CODE_REVIEW.md) is retained as historical context. Its four defect reproductions now run as ordinary passing regressions.

## Architecture

See [architecture and supported flows](docs/ARCHITECTURE.md) for component boundaries, data ownership, user flows, and failure behavior. The [standalone HTML edition](docs/ARCHITECTURE.html) includes all seven diagrams and works offline.

## Local development

Use Node 22.19.0 (`nvm use`) and Python 3 for backup/restore tests.

```sh
npm ci
npm run db:local
npm run dev:worker
```

In another terminal run `npm run dev`, then open http://127.0.0.1:5173. The local email inbox can bootstrap a synthetic host and capture sign-in emails. Nothing is sent externally. Production disables these helpers.

For shared-link signup testing, run `npm run dev:email` in a third terminal. This local provider fixture resets its address map on restart. POST `{"email":"friend@example.test"}` to `http://127.0.0.1:8790/__verify` to simulate verification. Never deploy the fixture.

## Verification

```sh
npm run check
npm run format:check
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Vitest executes Worker routes against isolated workerd/D1/R2 bindings. Playwright drives Chromium through the real React frontend and routes API requests into those isolated bindings. Browser fixtures use synthetic people and images, capture email, and require no Cloudflare credentials. They do not call production.

CI runs these checks on pushes and pull requests. It uploads browser traces and screenshots for 14 days. Regressions cover offline draft recovery, ambiguous saves, scheduling isolation, rotating questions, use-once member questions, reminder images and mobile layout. CI contains no expected-failure annotations.

## Group covers and email photos

See [cover editing and email previews](docs/EMAIL_PHOTOS.md). Images are inline email attachments; web photos remain private.

## Deployment

See [deployment and operations](docs/DEPLOYMENT.md). Copy `wrangler.example.jsonc` to the ignored `wrangler.jsonc` and supply your own resources. Outbound email is disabled in the template. No production credentials, group data, invitation links, private backups, or prior operational history are included.

## Source layout

- `src/`: application screens, common UI, API client and browser photo preparation.
- `server/`: Hono routes, authorization, newsletter scheduling, outbox, uploads, account lifecycle, exports and cleanup.
- `shared/`: calendar rules and timezone validation.
- `migrations/`: D1 schema and constraints.
- `scripts/`: encrypted backup and isolated recovery tools.
- `tests/`, `e2e/`: isolated backend and browser verification.
- `docs/`: review, repair acceptance criteria, and synthetic visual evidence.

Group settings control the number of rotating bank questions (one by default), question reminder timing (24 hours before questions close), and submission reminder timing (24 hours before delivery). Questions close seven days before delivery. Member questions enter the queue automatically and are included once; each issue has at most ten questions. Hosts can upload a separate image for submission reminders. Members can opt out of each email type independently.
