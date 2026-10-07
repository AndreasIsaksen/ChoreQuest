# ChoreQuest

ChoreQuest is a household chore tracker with individual and shared tasks, recurring schedules, and a points system. Administrators manage the household and assign work; members track their chores, mark them complete, and request changes from a shared, responsive dashboard.

The application runs on **Node.js, Express, EJS, and PostgreSQL**, with Docker Compose for installation. The interface supports **English and Norwegian Bokmål**, including a language preference remembered in the browser. There is no separate frontend build.

## What you can do

- **Track chores:** use list and month-calendar views, progress summaries, and status filters. Administrators can also filter by member and see household-wide work.
- **Build a chore library:** save reusable names, descriptions, and point values, then create one-off or recurring assignments. Library edits apply to new plans; existing assignments keep their saved details.
- **Assign individual or co-op work:** individual tasks track each member separately; co-op tasks share completion across participants. One-off tasks can be left unassigned or without a deadline.
- **Schedule recurring chores:** choose intervals in days, weeks, or months, with inclusive completion windows. Pause and resume schedules; missed periods are generated after downtime.
- **Manage points:** completion awards points to each participant; missed deadlines incur a single deduction per participant. Weekly balances transfer into permanent balances on Monday in `Europe/Oslo`. Administrators can add or withdraw points with a reason and review adjustment history.
- **Manage accounts:** administrators create members, reset passwords, change roles, and permanently delete accounts. There is no public registration.
- **Handle requests:** members submit chore-change, deadline-change, or general requests; administrators review them and leave a note.

## Current project state

This is a working prototype with automated tests, versioned database migrations, server-side role checks, chore ownership checks when submitting requests, CSRF protection, and session renewal on login. It remains best suited to local evaluation and controlled development.

During the September 28, 2026 review, the Docker image built successfully and all 27 tests passed against a disposable PostgreSQL 16 database, with no skips. The administrator password setup below was also exercised. These checks do not establish production readiness.

The current source has progressed beyond the original [foundation review](docs/foundation-review.md): request decisions now run in a transaction, account management and points are implemented, and the dashboard has been redesigned. That document and the [server assessment](docs/server-assessment.md) are historical context, not a current feature checklist.

Remaining limitations found in the current implementation:

- Sessions use an in-memory store: restarting the web process signs everyone out, and sessions are not shared between multiple web instances.
- Database initialization creates fixed seed accounts. There is no first-run account wizard; use the password setup below before signing in.
- Request decisions can be changed repeatedly. Approval does not recheck the requester's current chore membership or restrict deadline edits to deadline-change requests.
- Compose uses the same privileged database account for initialization, migrations, and application queries. Standalone startup also has fallback database credentials and a fallback session secret; explicitly configure your own values.
- Actual chore trades, threaded conversations, and weekly calendar views are not implemented. The proposed Blazor/.NET rewrite has not been implemented.

## Install with Docker Compose

You need Git, Docker Engine with Docker Compose, and OpenSSL for generating secrets. The checked-in Dockerfile uses `node:20-alpine`; Compose uses `postgres:16-alpine`.

### 1. Get the project

```bash
git clone https://github.com/AndreasIsaksen/ChoreQuest.git
cd ChoreQuest
cp .env.example .env
chmod 600 .env
```

Generate two separate secrets:

```bash
openssl rand -hex 32
openssl rand -hex 32
```

Edit `.env`: put one generated value in `SESSION_SECRET` and the other in `DB_PASSWORD`. For evaluation over HTTP on your own computer, use:

```dotenv
WEB_BIND_ADDRESS=127.0.0.1
WEB_PORT=8095
SESSION_COOKIE_SECURE=false
TRUST_PROXY=
```

Keep the other database settings from `.env.example`. The `false` cookie setting is required for this local HTTP setup; otherwise the browser cannot retain the secure session cookie and login/form submissions fail.

### 2. Build and start

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs --tail=50 web
```

Wait for the web log to report `ChoreQuest running on port 3000`. Compose exposes that internal port at [http://localhost:8095](http://localhost:8095), or your chosen `WEB_PORT`.

PostgreSQL stays on the internal Docker network and stores data in the `postgres_data` volume. On first installation, `db/init.sql` creates the base schema and seed users. The web process applies pending files from `db/migrations` at startup and records them in `schema_migrations`.

### 3. Set the administrator password

A fresh database contains `admin`, `alex`, and `sam`. Do not assume a default password works. On a **fresh installation**, run this command to generate a new administrator password:

```bash
docker compose exec -T web node <<'NODE'
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const db = require('./src/db');
(async () => {
  try {
    const password = crypto.randomBytes(24).toString('base64url');
    const hash = await bcrypt.hash(password, 12);
    const result = await db.query(
      "UPDATE users SET password_hash=$1, session_version=session_version+1 WHERE username='admin' AND role='admin' AND deleted_at IS NULL RETURNING id",
      [hash],
    );
    if (result.rowCount !== 1) throw new Error('Active seed administrator not found');
    console.log('Username: admin');
    console.log('Password: ' + password);
  } finally {
    await db.end();
  }
})().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
NODE
```

Store the printed password privately and sign in at [http://localhost:8095](http://localhost:8095). Running the command again changes the password and invalidates existing administrator sessions.

Under **Household**, reset the passwords of `alex` and `sam` if you want to use them, or permanently delete those sample accounts. Create your household's accounts here as well. Passwords entered through the app must be at least 12 characters and no more than 72 bytes.

### 4. Create your first chore

Open **Administration**, add a chore to the **Chore library**, then use **Administer chore** to select participants, assignment type, and schedule. Creating a library entry alone does not assign work. Members see their assignments under **Chores** and can complete them once their start date arrives.

Recurring assignments with a future start date appear under **Upcoming recurring chores** for the assigned members and administrators. The first task is generated when that date arrives. After administering a chore, you are taken to the household plan to review the assignment. Chores without a deadline also remain visible below the month calendar.

Choose **Selected weekdays** when administering a library chore to repeat on specific days, such as Monday, Wednesday and Friday. Each selected day gets its own task, starting on or after the chosen start date. Individual and co-op assignments both support this schedule, including pause/resume and generation of missed days after downtime.

The optional **Due time** applies to one-off chores, interval schedules and weekday schedules. For example, `14:00` means 14:00 in Europe/Oslo on the due date, including daylight-saving changes. Interval chores use that time on the last day of each completion window; weekday chores are due on their selected day. Leave the time blank for the existing end-of-day deadline. Overdue status, points deductions, late completion labels and one-hour reminders all use the chosen time.

In **Administer chore**, check **Set individual points for each member** to replace the shared points field with a points input beside each selected member. These values apply to that assignment, including future recurring tasks, while keeping the library default. Co-op chores still complete together, but each participant earns or loses their own assigned points. Zero points are allowed. Turn the option off to use the shared value again.

## Configuration and remote access

| Setting | Purpose |
| --- | --- |
| `SESSION_SECRET` | Session signing secret. Required by Compose; set explicitly for standalone use too. |
| `DB_PASSWORD` | Database password. Required by Compose. |
| `WEB_BIND_ADDRESS` / `WEB_PORT` | Compose host binding; defaults to `127.0.0.1:8095`. |
| `SESSION_COOKIE_SECURE` | `true` by default for HTTPS; use `false` for explicit local HTTP. Only these two values are accepted. |
| `TRUST_PROXY` | Comma-separated trusted proxy IPs/CIDRs; empty trusts no proxy. |
| `DB_NAME` / `DB_USER` | Database name and login; both default to `chorequest`. |
| `DB_HOST` / `DB_PORT` | Standalone database connection. Compose fixes these to `db:5432`. |
| `PORT` | Standalone web port, default `3000`. Compose fixes the internal port to `3000`. |

For a remote development server, leave the web binding on loopback and connect through an SSH tunnel, substituting your own user and host:

```bash
ssh -N -L 8095:127.0.0.1:8095 user@your-server
```

Then open `http://localhost:8095` on your computer with local HTTP cookie mode enabled on the server.

For HTTPS behind a reverse proxy, set `SESSION_COOKIE_SECURE=true` and trust only the proxy's actual address/subnet in `TRUST_PROXY`. Configure the proxy to overwrite forwarded headers. The supplied Compose file does not provide TLS. Recreate the web container after configuration changes:

```bash
docker compose up -d --build web
```

## Run without Docker

Install Node.js and npm (the container uses Node 20), PostgreSQL 16, and the PostgreSQL command-line tools. From the cloned repository:

```bash
npm ci
cp .env.example .env
chmod 600 .env
```

Using a PostgreSQL administrator account, create a login and database. For a local installation with peer authentication, for example:

```bash
sudo -u postgres createuser --pwprompt chorequest
sudo -u postgres createdb --owner=chorequest chorequest
psql -h 127.0.0.1 -U chorequest -d chorequest -W -f db/init.sql
```

Set `DB_HOST=127.0.0.1`, `DB_PORT=5432`, `DB_NAME=chorequest`, and `DB_USER=chorequest` in `.env`, with `DB_PASSWORD` matching the password you just chose. Set a random `SESSION_SECRET`, `SESSION_COOKIE_SECURE=false` for local HTTP, and optionally `PORT=3000`.

```bash
npm start
```

After migrations finish, run the first-login script above from the project root in another terminal, replacing its opening `docker compose exec -T web node <<'NODE'` line with `node -r dotenv/config <<'NODE'`. Open [http://localhost:3000](http://localhost:3000). Unlike the Compose loopback mapping, standalone startup does not specify a listen address; use appropriate network restrictions for local evaluation.

## Tests

With dependencies installed:

```bash
npm test
```

Or run tests in Docker:

```bash
docker build -t chorequest-test .
docker run --rm chorequest-test npm test
```

The default run covers authentication, sessions, CSRF, proxy/cookie configuration, language handling, rendered translations, and date helpers. PostgreSQL integration suites are skipped unless `TEST_DATABASE_URL` is set:

```bash
TEST_DATABASE_URL=postgres://test_user:test_password@127.0.0.1:5432/chorequest_test npm test
```

Use a **fresh, disposable database**, never the household database: integration tests create and modify accounts, chores, schedules, and point records. They initialize their schema themselves. These suites cover administration, recurring/co-op chores, deletion, points settlement, and manual point adjustments.

## Updates and data

For an existing installation, back up PostgreSQL before updating code or applying migrations:

```bash
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > chorequest-backup.sql
git pull --ff-only
docker compose up -d --build
```

Keep backups private and verify restoration in a separate database. Startup migrations run automatically; `db/init.sql` runs only when the database volume is empty. Changing `DB_PASSWORD` in `.env` does not rotate an existing database's password.

`docker compose down` stops the application and retains its data volume. **Do not add `-v` unless you intend to erase the database.** Permanent member deletion also erases that member's requests, point balances, ledger, and participation history; existing backup files are not changed.

Removing chores preserves completed and already-overdue history under **Removed** status. Other removed tasks disappear and do not incur future penalties. Member late completion earns the normal points award while retaining any missed-deadline deduction. Administrators can use **Change chore status** on assigned chores to set **Done** or **Not done**, including after the deadline. Setting Done corrects the net chore points to the full reward: a previously deducted 10-point chore receives 20 points in the current week, balancing the deduction already transferred to the permanent bank. Setting Not done reverses awards and compensation, retaining the overdue deduction where applicable. Co-op status changes apply to every participant; repeated saves do not award extra points.

## Repository layout

```text
src/server.js       Express routes, authentication, dashboard, maintenance loop
src/admin.js        Account, chore, schedule, and point administration
src/views/          EJS pages and partials
src/public/         Browser JavaScript and CSS
src/locales/        Norwegian translations
src/migrate.js      Transactional migration runner
src/db.js           PostgreSQL connection pool
db/init.sql        Initial schema and seed accounts
db/migrations/     Versioned schema and database functions
test/              Node test runner suites
docs/              Historical architecture and server assessments
```

## Push notifications

Generate a stable VAPID key pair with `npx web-push generate-vapid-keys` (or `docker compose run --rm web npx web-push generate-vapid-keys`). Set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` (a contact URI such as `mailto:admin@example.com`) in `.env`, then recreate the web container. Keep the private key private and retain both keys across restarts. Without these settings push is disabled; the rest of the application works normally.

Members choose **Enable notifications on this device** on the dashboard and grant browser permission. Repeat on each device. Web Push requires HTTPS (localhost is permitted for development). On iPhone/iPad, add the app to the Home Screen before enabling notifications. Admin settings cannot grant browser permission.

Under **Administration → Member points**, each member card has **Push notification settings** and a registered-device count. All three categories default to enabled for existing and new accounts: one-hour reminders, manual assignments, and requests/approvals. Date-only deadlines expire at midnight after the due date in Europe/Oslo, so reminders are queued at 23:00 on that date, including daylight-saving changes. The maintenance worker checks each minute; completed, removed, unassigned, and undated chores receive no reminders. It does not send late reminders after downtime.

Manual assignments (including recurring plans) notify the assigned members. Requests may name an optional recipient, who sees the request and receives a notification. All active admins receive approval alerts. Approval notifies the requester and optional recipient; saving an already-approved decision again does not notify twice. This does not implement chore trades.

Notifications are queued transactionally, delivered to all registered devices, and retried up to five times for temporary failures. Expired browser subscriptions are removed; deadline notifications expire at the deadline and other events after one day. Disabled preferences are checked again before delivery. Push services and device settings determine final delivery; reminders are best effort. On shared browsers, an existing subscription follows the most recently signed-in account; pending notifications for the previous account are cleared. Disable device notifications before sharing a device if you want no notifications after logout.
