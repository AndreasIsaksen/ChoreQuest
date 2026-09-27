# ChoreQuest

A household chore application at the foundation-review stage. The executable prototype uses Node.js, Express, EJS, and PostgreSQL. Future development is planned around a mobile-first Blazor client and a layered ASP.NET Core backend.

Read the [foundation review](docs/foundation-review.md) for prioritized findings, requirement coverage, project boundaries, permissions, trade/deadline rules, calendars, notifications, and implementation acceptance gates. The [server assessment](docs/server-assessment.md) records the inspected Docker environment and database recommendation.

## Current scope

The app now uses one shared login and dashboard for admins and members, with responsive navigation, chore cards, status filters, a month calendar, progress summaries, and request forms. Admins additionally see household-wide chores, member filters, the household roster, assignment tools, and request review. Members only see their own chores and requests; API guards enforce admin privileges. Legacy `/admin` and `/profile` URLs redirect to `/dashboard` after the appropriate access checks.

Account administration, actual chore trades, threaded conversations, weekly calendars, and notifications remain future work. This redesign uses the existing Express/EJS runtime; the planned Blazor migration is separate.

**Do not deploy this prototype for real use yet.** The review identifies authentication, request-ownership, and transaction issues. The HTTP session/CSRF bug is fixed with an explicit deployment setting described below; request-ownership and transactional approval findings remain. Replace fixed seed accounts before household deployment. The historical `password123` documentation does not match the seeded password hash.

## Prepare Docker configuration

```bash
cp .env.example .env
chmod 600 .env
```

Set `SESSION_SECRET` and `DB_PASSWORD` to separate random values (generate each with `openssl rand -hex 32`). Set `WEB_PORT` to an available host port. `WEB_BIND_ADDRESS` defaults to loopback.

For local HTTP accessed through an SSH tunnel, explicitly set `SESSION_COOKIE_SECURE=false` in the server `.env`. Keep `TRUST_PROXY` empty. From your computer, run:

```bash
ssh -N -L 8095:127.0.0.1:8095 aragnaroth@10.230.1.208
```

Then open <http://localhost:8095>. HTTP mode keeps HttpOnly, SameSite=Lax, and CSRF protection, but does not encrypt browser traffic itself; the SSH tunnel protects the remote connection. The server binding remains loopback.

For HTTPS, keep `SESSION_COOKIE_SECURE=true` (the default). If TLS terminates at a reverse proxy, set `TRUST_PROXY` to only that proxy's IP address or CIDR, and ensure the proxy overwrites forwarded headers. Empty `TRUST_PROXY` trusts no proxy. Invalid cookie-mode values fail startup. Do not enable blanket proxy trust or expose plain HTTP with passwords on a public network.

Compose passes these settings into the web container; recreate it after changes with `docker compose up -d --build web`. Login regenerates the session and CSRF token, saves the session before redirecting, and logout destroys it. Sessions still use the prototype's in-memory store, so restarting the web container signs users out.

```bash
docker compose config --quiet
```

The web container always listens internally on port 3000; changing `WEB_PORT` changes only the published host port. PostgreSQL uses `db:5432` on the Compose network and publishes no host port. Database credentials are passed explicitly to the services; missing secrets stop Compose validation. `DB_HOST` and `DB_PORT` in the example are for standalone development; Compose fixes these to its dedicated database service.

After resolving the review's deployment blockers, start with `docker compose up -d --build`. Database readiness gates web startup. Initialization SQL runs only on a new empty database volume; changing `.env` does not rotate an existing PostgreSQL password. Do not remove a data volume to apply schema changes—use migrations and backups.

Both Git and the Docker build context exclude real `.env` files and variants. Only the non-secret `.env.example` is tracked. Never paste `docker compose config` output containing resolved secrets into a ticket; use `--quiet` for validation.

## Development and tests

The legacy app can be installed with `npm ci`; it requires a PostgreSQL database initialized from `db/init.sql`. `npm start` loads `.env` and uses port 3000 by default. Use the cookie mode appropriate to your HTTP or HTTPS setup as described above. Fixed seed hashes are prototype fixtures, not a production bootstrap mechanism.

```bash
npm test
```

If Node is not installed locally, run the full suite in the built image:

```bash
docker build -t chorequest-test .
docker run --rm chorequest-test npm test
```

The suite covers HTTP admin/member login, session/CSRF renewal, logout, invalid credentials, CSRF rejection, secure-cookie defaults, trusted/untrusted forwarding, and the existing date helpers. Authentication tests need dependencies: use `docker build -t chorequest-test .` followed by `docker run --rm chorequest-test npm test` for the full containerized suite. Passing tests does not establish full application readiness; see the remaining acceptance gates in the review.
