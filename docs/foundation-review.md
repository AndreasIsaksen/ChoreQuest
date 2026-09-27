# Foundation review

Reviewed 2026-09-27 against baseline commit `357f8b6`.

## Decision

Keep this prototype as a behavior reference, but move future feature development to a layered .NET 10 solution with a mobile-first Blazor frontend. The current implementation is not ready for household use: authentication over the documented HTTP deployment is broken, request ownership is not enforced, and the data model cannot preserve responsibility at a missed deadline.

This branch records the review and prepares container configuration. It does **not** implement the Blazor migration or the requested business features. The executable application remains Express/EJS.

## Current structure and findings

The useful starting points are parameterized SQL, password hashing, CSRF tokens, admin route guards, member-scoped chore queries, and a separate database container with persistent storage. `src/server.js` currently combines HTTP endpoints, authentication, authorization, workflow logic, and SQL. `src/db.js` only wraps the connection pool; it is not an application/data-access layer.

Line references below refer to the reviewed baseline, whose application files are unchanged on this branch.

| Priority | Finding and evidence | Required correction |
| --- | --- | --- |
| P1 | `src/server.js:25–47` sets `secure: true`, while README/Compose expose plain HTTP. The session cookie is not set over HTTP, so the next form submission has a different CSRF token and fails. Proxy trust is also absent. | Use HTTPS with explicitly trusted proxy forwarding. Test login, logout, CSRF, and cookie persistence through the actual deployment path. Do not silently weaken production cookies. |
| P1 | `src/server.js:129–135` accepts an arbitrary `choreId`; the foreign key proves existence, not ownership. A member can attach a request to another member's chore, and approval at `165–177` can change it. | Require the authenticated member to own the requested assignment on creation and revalidate ownership when deciding it. Never trust a posted member ID. |
| P1 | `src/server.js:165–177` updates request status and due date in separate statements, allows repeated decisions and reversals, and does not check request type or original state. | Make decisions transactional, conditional on pending state, authorized, auditable, and idempotent; reject stale/conflicting changes. |
| P1 | `db/init.sql:9–28` stores one mutable assignee, a date, and a boolean. There is no trade model, deadline timestamp, completion timestamp, responsibility history, or missed-deadline record. | Introduce assignment occurrences and immutable history before implementing trades or overdue reporting. |
| P1 | `db/init.sql:31–36` seeds fixed password hashes and README advertises a shared default password. `src/server.js:27` has a fallback signing secret; sessions use the default in-memory store. Login does not regenerate the session. | Replace fixed accounts with one-time admin bootstrap, force password setup, persist sessions/Identity keys, regenerate sessions at login, and invalidate access on account disable/role change. Verify bootstrap instead of assuming the documented password matches the seed hash. |
| P1 | Original `Dockerfile:5` uses `COPY . .` without `.dockerignore`, so local `.env` credentials can be baked into an image. | Addressed on this branch by excluding environment files and Git/build artifacts from the Docker context. |
| P2 | `src/helpers.js:3` assumes an ISO string. node-postgres normally returns PostgreSQL DATE values as JavaScript `Date` objects; `String(date)` does not start with `YYYY-MM`. Existing tests only use strings. | Use a date-only representation and database range queries; test actual database-returned values. |
| P2 | `src/views/*.ejs` have viewport tags but no responsive styling. The member “calendar” is a date-grouped list; admin has only a list. | Add the mobile agenda, week/month calendars, accessible controls, and admin member filters described below. |
| P2 | `src/server.js:121–125` blindly toggles completion. Duplicate submits can undo completion and there is no completion time. | Use an idempotent completion command with ownership check and server timestamp; reopening is an explicit audited action. |
| P2 | Admin routes only create assignments and decide requests. There are no account lifecycle, chore edit, assignment edit/reassign, or notification operations. Input validation is largely delegated to SQL. | Add validated application commands and authorization policies before UI controls. Return meaningful 400/403/404/409 responses. |
| P2 | Original Compose fixes port 3000 and only waits for container startup. Initialization SQL only runs for an empty volume; there is no migration or backup workflow. | This branch adds configurable host binding, database readiness, restart policies, and mandatory secrets. Versioned migrations and restore-tested backups remain required. |

The prototype Dockerfile also remains on Node 20; select and validate a supported runtime if it is maintained during migration. Do not mistake the deployment preparation for production readiness.

## Requirement coverage

| Requirement | Current state | Target |
| --- | --- | --- |
| Mobile-first Blazor | Absent; EJS forms | Blazor responsive components with agenda-first navigation |
| Layered backend and separate containers | Database separated; server code monolithic | Domain, Application, Infrastructure, API, Web, Worker boundaries |
| Admin-only account management | Absent | Create, disable, reset credentials, manage roles; no public registration |
| Admin-only chore/assignment administration | Create only | Chore definitions plus assigned occurrences, edit/reassign/archive with audit |
| Members see their own work | Chore list scoped correctly | Enforce scope on all queries, commands, calendars, notifications, and exports |
| Trade request and communication | Generic one-message request only | Participant conversation and admin-approved atomic trade |
| Original member accountable until approval | No transfer or historical outcome model | Effective-dated responsibility plus frozen deadline outcome |
| Week/month calendars and collective admin view | Partial member list; no admin calendar/filter | Shared range queries powering agenda, week, month, and member filter |
| Configurable reminders per chore/member | Absent | Durable scheduled notifications with explicit override precedence |

## Proposed Blazor solution

Use a standalone Blazor WebAssembly client served by a web container, with `/api` reverse-proxied to a separate ASP.NET Core API container on the same origin. This provides a clear frontend/backend deployment boundary. The browser never connects to PostgreSQL. API and worker are reachable only on the application Docker network; only the web gateway publishes a host port. HTTPS terminates at that gateway or a configured upstream proxy.

Proposed projects (a design, not projects already scaffolded):

```text
ChoreQuest.sln
src/ChoreQuest.Domain          Entities, invariants, domain events; no framework dependencies
src/ChoreQuest.Application     Commands, queries, authorization, transaction/clock interfaces
src/ChoreQuest.Infrastructure  EF Core/Npgsql, Identity persistence, migrations, notification adapters
src/ChoreQuest.Contracts       API request/response types; no persistence entities or secrets
src/ChoreQuest.Api             HTTP boundary, authentication, validation, application composition
src/ChoreQuest.Web             Blazor components, responsive styles, typed API client
src/ChoreQuest.Worker          Durable reminder/outbox processing and deadline reconciliation
tests/ChoreQuest.Domain.Tests
tests/ChoreQuest.IntegrationTests
tests/ChoreQuest.EndToEndTests
```

Application depends on Domain; Infrastructure implements Application interfaces; Api and Worker compose these layers. Web references Contracts only. Keep database entities and persistence out of the frontend. Layers do not each require containers: deploy Web, Api, Worker, and PostgreSQL; run migrations as a controlled one-off job. Persist ASP.NET data-protection keys separately from disposable containers.

Use ASP.NET Core Identity with same-origin HttpOnly secure cookies and antiforgery protection on state-changing requests. Remove public registration endpoints, even if hidden in the UI. Bootstrap the first admin from a one-time secret and require password setup. Enforce roles and resource ownership in the API/application layer; Blazor UI visibility is not a security boundary. Protect the last active administrator from accidental removal. Disable accounts rather than cascading away historical assignments and audit records.

Member writes are limited exceptions to admin administration: mark their own assignment complete, create/cancel their own pending requests, respond in conversations they participate in, and acknowledge notifications. Members cannot change assignees, due dates, request decisions, reminder schedules, or other members' accounts. Admin can manage these through audited commands.

## Trade and deadline contract

Separate `ChoreDefinition` from `ChoreAssignment` (an individual occurrence). Store `OriginalAssigneeId`, current assignee, `DueAt` as a UTC instant, `CompletedAt`, a concurrency version, and append-only assignment history with effective timestamps. Store the household timezone separately, initially `Europe/Oslo`; local date/time input must be resolved explicitly across daylight-saving transitions.

Add `TradeRequest` with requester, offered assignment, target member, optional requested assignment for a two-way swap, expected assignment versions, status, decision metadata, and participant messages. Only participants and admins can read the conversation. Any target-member acceptance records consent, not an ownership change. Provide only minimal eligible trade summaries through a dedicated endpoint; do not expose another member's full calendar or private request history.

1. Creating a pending request leaves every assignment and reminder with the current member. Ownership is not reserved or transferred merely because a trade is discussed.
2. Admin approval locks the request and involved assignments in a consistent order, captures the database decision time **after** acquiring the locks, and revalidates pending state, ownership, active members, expected versions, completion, and deadlines. This avoids accepting a decision that waited on a lock until after the deadline.
3. If still valid, change both sides of a swap in one transaction; append history and audit events, mark the request approved, and replace future reminder jobs in the same transaction using an outbox. No partial swap is allowed.
4. Treat `now >= DueAt` as too late for a trade. Expire the pending request rather than retroactively moving responsibility. An admin may create a new follow-up assignment, while the original missed-deadline record remains unchanged.
5. At the deadline, record the responsible member from assignment history effective at that instant, even if the worker processes it later. A pending trade therefore leaves accountability with the original assigned member. If a trade was approved before the deadline, accountability belongs to the new assignee.
6. Completion is on time only when its authoritative server timestamp is before `DueAt`; later completion records `CompletedLate` without erasing the missed deadline. Approval, completion, and deadline processing must serialize on the assignment and use consistent boundary rules.

Reject stale, completed, rejected, expired, or already-transferred assignments with a conflict response. Retrying an already successful command returns its original outcome without applying changes twice. Due-date edits also preserve prior outcomes; they cannot silently erase an already missed deadline. Audit admin overrides explicitly.

## Calendar and mobile behavior

Start with a single-column “My chores” agenda on narrow screens, clear due times/status, large touch controls, and no required horizontal scrolling at 320–390 CSS pixels. Add week/month navigation and a selected-day agenda; a compact month grid can show counts without cramming descriptions into cells. On larger screens show full weekly/monthly layouts. Support keyboard focus, screen-reader labels, readable contrast, and statuses conveyed by text as well as color.

Admin gets an all-member list and calendar using the same date-range query and a member filter. Members' queries always derive the user ID from authentication; changing query parameters cannot broaden access. Use half-open UTC ranges `[start, end)` derived from household-local week/month boundaries, default to Monday-start weeks, and show overdue work distinctly. Test month/year rollover, empty ranges, and Oslo daylight-saving transitions. Pending trade badges must not remove chores from the original member's calendar.

## Notifications

Use a persisted `ReminderRule` and `NotificationJob` model. Admin can set a chore default and a per-member override for that chore, including disabling a reminder or selecting an explicit time for an assignment. Precedence: assignment/member override, then chore/member rule, then chore default. Show the resolved schedule in the admin form. Store the chosen local timezone and the computed UTC send time; validate that reminders precede the deadline. If a newly computed reminder is already past but the chore is not due, enqueue one immediate catch-up reminder.

The worker claims due jobs with leases/row locking, writes durable attempt history, retries transient failures with backoff, and exposes failed jobs for admin review. Use a unique deduplication key including assignment, recipient, reminder rule/version, and scheduled time. Re-read completion/ownership immediately before dispatch; completion cancels pending reminders, pending trades do not redirect them, and approved trades/due-date edits replace them atomically. Commit notification creation through a transactional outbox so a restart cannot lose it. External delivery is at-least-once unless the provider supports idempotency; do not claim exactly-once push/email delivery.

Use an in-app notification inbox plus Web Push for delivery when the app is closed; browser permission/subscription and HTTPS are prerequisites. If permission is denied or unsupported, show that state and offer an email channel once configured. A live SignalR connection alone is not an off-screen reminder solution. Channel choice and member consent affect delivery, not the admin-controlled reminder time. The worker must catch up after restart and reconcile overdue outcomes independently of reminder delivery.

## Implementation sequence and acceptance gates

1. Scaffold the layered .NET solution and containers; add Identity/admin bootstrap, server-side permissions, migrations, structured logs, health endpoints, backups, and restore verification. Export any existing data before migration; do not reuse prototype seed accounts as production identities.
2. Implement account/chore/assignment administration, member-scoped queries, completion timestamps, audit history, and overdue accountability. Test direct unauthorized HTTP requests, not just UI visibility.
3. Implement trades/conversations and transactional decisions. Test concurrent approvals, approval versus completion, approval exactly at the deadline, repeated commands, expired requests, disabled members, and worker restart after the deadline. Specifically prove that an unapproved trade still records the original member as overdue.
4. Build mobile agenda and week/month/admin views over the same authorized query model. Verify viewport sizes, accessibility, timezone boundaries, and member-filter isolation.
5. Implement the durable notification worker and real delivery channel. Test per-member overrides, retries, duplicate worker claims, cancellation, reassignment, daylight-saving changes, downtime, denied browser permission, and failed-delivery visibility.

Existing tests cover only two helper cases using strings. They cannot establish authentication, authorization, transaction integrity, calendar correctness against PostgreSQL, or notification reliability. Keep the prototype off the live network until the P1 findings are fixed and the replacement has passed its acceptance gates.

## Verification performed on this branch

- Both existing Node helper tests passed in the prototype's Node 20 container.
- The Docker image built successfully with `npm ci --omit=dev`.
- Compose parsed successfully; checks confirmed port 8095 maps to internal port 3000, loopback is the default binding, PostgreSQL publishes no host port, and web startup waits for database readiness. Missing secrets correctly fail validation.
- Git ignore checks covered root/nested `.env`, `.env.production`, and `prod.env`, while retaining `.env.example`. An image built with a non-secret `.env.foundation-probe` sentinel excluded both that file and `.git`.
- An HTTP probe reproduced missing session cookies on `/login` and a subsequent CSRF 403. A node-postgres DATE parser probe reproduced the empty month-filter result. These confirm unresolved findings, not passing application acceptance tests.
- Server inspection used Docker metadata, host listeners, a temporary port bind, and read-only PostgreSQL queries. No full application integration, load, notification, backup/restore, or Blazor tests were claimed.

## Reference documentation

- [Blazor hosting models](https://learn.microsoft.com/aspnet/core/blazor/hosting-models) and [Identity with standalone Blazor WebAssembly](https://learn.microsoft.com/en-us/aspnet/core/blazor/security/webassembly/standalone-with-identity/?view=aspnetcore-10.0) inform the proposed frontend/API boundary.
- [Blazor authentication and authorization](https://learn.microsoft.com/en-us/aspnet/core/blazor/security/?view=aspnetcore-10.0) explains why client-side authorization does not protect server resources.
- [node-postgres date types](https://node-postgres.com/features/types) documents conversion of database DATE values to JavaScript Date objects.
- [Compose interpolation](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/) and [startup order](https://docs.docker.com/compose/how-tos/startup-order/) support the environment and readiness configuration.
