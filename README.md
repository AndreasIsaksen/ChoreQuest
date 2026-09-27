# ChoreQuest

A household chore application at the foundation-review stage. The executable prototype uses Node.js, Express, EJS, and PostgreSQL. Future development is planned around a mobile-first Blazor client and a layered ASP.NET Core backend.

Read the [foundation review](docs/foundation-review.md) for prioritized findings, requirement coverage, project boundaries, permissions, trade/deadline rules, calendars, notifications, and implementation acceptance gates. The [server assessment](docs/server-assessment.md) records the inspected Docker environment and database recommendation.

## Current scope

The prototype provides member chore lists, completion toggles, admin chore assignment, and basic requests. Account administration, actual chore trades, request conversations, weekly/monthly calendar grids, and notifications are not implemented. This branch prepares deployment configuration; it does not migrate the application to Blazor.

**Do not deploy this prototype for real use yet.** The review identifies authentication, request-ownership, and transaction issues. In particular, session cookies require HTTPS, so the previously documented plain-HTTP login does not work. Resolve those findings and replace fixed seed accounts before deployment.

## Prepare Docker configuration

```bash
cp .env.example .env
chmod 600 .env
```

Set `SESSION_SECRET` and `DB_PASSWORD` to separate random values (generate each with `openssl rand -hex 32`). Set `WEB_PORT` to an available host port. `WEB_BIND_ADDRESS` defaults to loopback; connect an HTTPS gateway before making the application accessible to the household. Configure trusted proxy forwarding in the application as part of the authentication fix.

```bash
docker compose config --quiet
```

The web container always listens internally on port 3000; changing `WEB_PORT` changes only the published host port. PostgreSQL uses `db:5432` on the Compose network and publishes no host port. Database credentials are passed explicitly to the services; missing secrets stop Compose validation. `DB_HOST` and `DB_PORT` in the example are for standalone development; Compose fixes these to its dedicated database service.

After resolving the review's deployment blockers, start with `docker compose up -d --build`. Database readiness gates web startup. Initialization SQL runs only on a new empty database volume; changing `.env` does not rotate an existing PostgreSQL password. Do not remove a data volume to apply schema changes—use migrations and backups.

Both Git and the Docker build context exclude real `.env` files and variants. Only the non-secret `.env.example` is tracked. Never paste `docker compose config` output containing resolved secrets into a ticket; use `--quiet` for validation.

## Development and tests

The legacy app can be installed with `npm ci`; it requires a PostgreSQL database initialized from `db/init.sql`. `npm start` loads `.env` and uses port 3000 by default. Its current login still requires the authentication/deployment fixes described above. Fixed seed hashes are prototype fixtures, not a production bootstrap mechanism.

```bash
npm test
```

If Node is not installed locally, run the existing helper tests with the prototype's container runtime:

```bash
docker run --rm -v "$PWD:/app:ro" -w /app node:20-alpine npm test
```

These two tests are limited to string-based date helpers. Passing them does not establish application readiness; see the integration and workflow acceptance gates in the review.
