# ChoreQuest

A household chore application at the foundation-review stage. The executable prototype uses Node.js, Express, EJS, and PostgreSQL. Future development is planned around a mobile-first Blazor client and a layered ASP.NET Core backend.

Read the [foundation review](docs/foundation-review.md) for prioritized findings, requirement coverage, project boundaries, permissions, trade/deadline rules, calendars, notifications, and implementation acceptance gates. The [server assessment](docs/server-assessment.md) records the inspected Docker environment and database recommendation.

## Current scope

The app now uses one shared login and dashboard for admins and members, with responsive navigation, chore cards, status filters, a month calendar, progress summaries, and request forms. Admins additionally see household-wide chores, member filters, the household roster, assignment tools, and request review. Members only see their own chores and requests; API guards enforce admin privileges. Legacy `/admin` and `/profile` URLs redirect to `/dashboard` after the appropriate access checks.

Members and admins can switch between **English** and **Norsk (Norwegian Bokmål)** using the radio toggle on the login page and dashboard header. The choice takes effect immediately, preserves the current dashboard filters, and is remembered in that browser for one year, including after sign-out. English is the default. Interface labels, dates, statuses, validation messages, and admin tools are translated; household-entered names, chore descriptions, and request text stay as written. Without JavaScript, select a language and press **Apply language / Bruk språk**. Translations live in `src/locales/nb.json`, keyed by the corresponding English copy and shared across the existing views.

Actual chore trades, threaded conversations, weekly calendars, and notifications remain future work. This redesign uses the existing Express/EJS runtime; the planned Blazor migration is separate.

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

## Admin chores and accounts

The **Chore library** permanently stores chore names and descriptions. Creating a chore only saves its definition. Use **Administer chore** to select members, assignment type, a one-off or recurring schedule, start date and deadline. Reuse the definition for new assignments without recreating it. Editing a library entry affects new assignments; existing tasks and schedules preserve their details and history. Existing chores are imported into the library during migration, combining identical names and descriptions.

**Individual** assignments create a separate task (or recurring schedule) for each selected member, with independent completion records: for example, everyone does their own laundry. **Co-op** assignments create one shared task for two or more selected members. All participants see the co-op label and group names in their feed. Any participant can complete or reopen the shared task for everyone. Submitting “complete” twice from separate browsers keeps it completed. Admin member filters and calendar views include shared chores. Nonparticipants cannot see, complete, or request changes to these tasks.

Admins can also create unassigned one-off tasks, optionally without a deadline, then assign them later. Recurring chores use a start date and an interval of 1–365 days, weeks, or months. Each occurrence has an inclusive start/end window and can be completed once within that window; completing it does not change subsequent periods. Late completion is stored with its timestamp. Calendar views show the whole window. A future start date prevents early completion. To change a recurring schedule's timing or assignment type, pause it and create a new plan from its library entry.

For example, a two-week window starting Monday ends the second Sunday. Monthly boundaries remain anchored to the original date, so a January 31 start follows February 28/29 and March 31. New occurrences are generated at startup, every minute, and when loading a dashboard. Unique period keys and a PostgreSQL advisory lock prevent duplicates; after downtime, missing periods are created with their original deadlines. Schedules starting in the future appear under **Recurring schedules** until the first window begins. Pausing stops generation; resuming catches up missed windows. Schedule assignment changes affect future periods; individual chore assignment changes affect only that occurrence.

The **Household** page lets admins create accounts, change display names/roles, reset passwords, and remove or restore accounts. Removal is reversible: sign-in is revoked, current unfinished/undated individual chores and future periods become unassigned, and completed/overdue history remains. For co-op chores, the removed account leaves current unfinished tasks and future groups; other participants keep the task. Usernames stay reserved. Changes revoke existing sessions. An admin cannot remove or demote their own account, and at least one active admin must remain.

Schema changes in `db/migrations` are applied transactionally at startup and recorded in `schema_migrations`. Back up existing databases before deploying. Integration tests must run only against a disposable database: `TEST_DATABASE_URL=postgres://... npm test` creates fixture users and changes test data. Without this variable, database integration tests are skipped.

## Member points

Admins set a nonnegative whole-number **Points per member** value (0–1,000,000) in the chore library, including **Administer chore**. Each assignment and recurring schedule retains its saved value; changing the library applies to new plans. Existing library entries, tasks, and schedules start at zero, so deployment does not award or charge points retroactively. Create a new plan with a point value to start scoring it.

Members see their weekly and permanent balances on the overview and chores pages; admins also see each member’s balances under Household. Completing a task awards its value to each assigned member, including every co-op participant. Repeated completion submissions do not award extra points. Reopening reverses the completion award in the current week.

An unfinished task receives one deduction per assignee after its inclusive due date. There is no repeated daily charge. Undated and unassigned tasks incur no deduction. Late completion earns the normal award while retaining the missed-deadline charge. Changing an already missed deadline does not erase its penalty.

Weeks run Monday through Sunday in **Europe/Oslo**, including daylight-saving changes. At the Sunday-to-Monday boundary, the closing weekly balance moves into the permanent account and the new weekly balance starts at zero. Negative balances are supported in both accounts. A Sunday deadline’s penalty belongs to the closing week. Processing runs at startup, every minute, and before dashboard reads and chore/account changes; catch-up after downtime charges missed occurrences to their original weeks. Settlement may run up to a minute after midnight, and dashboard loading settles before showing balances.

The append-only points ledger records awards, reversals, and deductions. Weekly account buckets are retained and marked settled on transfer; permanent balances sum settled buckets. Transactions, an advisory lock, and a unique overdue-charge key protect against duplicate processing. Account removal preserves point history.
