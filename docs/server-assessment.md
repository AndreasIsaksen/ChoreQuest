# Server assessment

Inspected 2026-09-27 over SSH as `aragnaroth` on `10.230.1.208` (`minidock`, Ubuntu 24.04). Existing SSH key authentication succeeded. No supplied SSH password was stored in this repository or the application environment.

## Running Docker services

| Container | Image | Published host TCP ports | Observation |
| --- | --- | --- | --- |
| docker-server-api-1 | docker-server-api | 8081 → 8080 | Running |
| docker-server-web-1 | docker-server-web | 8080 → 8080 | Running |
| learnplane-webapp | learnplane-webapp | 8094 → 8080 | Running |
| learnplane-database | postgres:17-alpine | None | Healthy; PostgreSQL 17.11 |
| timelearn | timelearn:6d911da | 8093 → 8080 | Running |
| docker-server-postgres-1 | postgres:16-alpine | None | Healthy; PostgreSQL 16.15 |
| local-media-service-gateway-1 | 432c139603ec | 8092 → 8092 | Healthy |
| local-media-service-portal-1 | 5b732e629f15 | None | Healthy |

Two exited `hello-world` containers were also present. No ChoreQuest containers were present. Published Docker application ports in use were **8080, 8081, 8092, 8093, 8094**. Container-only port 5432 is not a host-port conflict: each database has its own container/network namespace.

`ss -lntu` also reported TCP listeners on 22, 53 (loopback), 1338 (loopback), 9099 (loopback), 10248/10249 (loopback), 10250, 10256 (loopback), 10257, 10259, 16443, 19001 (loopback), 25000, and 37031 (loopback). UDP listeners included 53, 68, 546, and 4789. These include host/platform services and are not spare application ports.

TCP **8095** was absent from both container port bindings and host listeners, and an actual temporary socket bind succeeded. Availability is a point-in-time observation, not a reservation; check again before startup.

## Server-local environment

Created `/home/aragnaroth/git/ChoreQuest/.env` with mode `0600`, ignored by Git. Its non-secret settings are:

```dotenv
WEB_BIND_ADDRESS=127.0.0.1
WEB_PORT=8095
DB_HOST=db
DB_PORT=5432
DB_NAME=chorequest
DB_USER=chorequest
```

`SESSION_SECRET` and `DB_PASSWORD` contain independent cryptographically generated values and are deliberately omitted here. The file exists only on the server. `.env.example` contains no credentials and is safe to commit.

The selected loopback binding prepares a local upstream at `127.0.0.1:8095` after startup; it is not currently serving an application and is not a household-facing URL. Before LAN use, implement HTTPS and the authentication fixes, then either use a host reverse proxy to this address or attach a containerized gateway to the private application network. A container's `127.0.0.1` is not the host loopback interface. The current gateway belongs to another application; its routing has not been changed.

## Can PostgreSQL be shared?

**Yes. A separate PostgreSQL container is not technically required.** Both existing instances can host an independent ChoreQuest database with its own restricted role. Do not place ChoreQuest tables inside another application's database or reuse its credentials.

Observed state:

| Instance | Network | Application database size | Connections / maximum | Existing application role |
| --- | --- | --- | --- | --- |
| PostgreSQL 16.15 | docker-server_eatme | eatme: approximately 8 MB | 6 / 100 | Superuser with create-role/create-database privileges |
| PostgreSQL 17.11 | learnplane_learnplane | learnplane: approximately 16 MB | 6 / 100 | Superuser with create-role/create-database privileges |

Connection counts include internal/admin sessions and are a snapshot, not load-testing results. Neither database has a container memory limit. Both persist data in named Docker volumes. No non-superuser application login was observed, so existing application credentials are unsuitable for ChoreQuest.

The host reported approximately 3.7 GiB RAM, 2.1 GiB available memory, 376 MiB swap in use, and 32 GiB free disk. Database container memory at inspection was roughly 12–16 MiB, excluding broader host/page-cache costs. This supports the feasibility of a small additional database container; it does not establish capacity under production load. Backup schedules and restore reliability were not verified.

**Recommendation: use a dedicated ChoreQuest PostgreSQL container initially**, as configured in this branch. Both existing clusters are owned by other Compose applications and live on their private networks. Independent lifecycle, upgrades, volume ownership, and restores outweigh the modest resource savings of sharing for this installation. This is an operational preference, not a claim that PostgreSQL cannot safely serve multiple applications.

The prototype uses `POSTGRES_USER` as the web database login, which the official image initializes with administrative privileges. Before real deployment, split bootstrap/migration credentials from a non-superuser runtime role with only the required schema/table/sequence privileges. The current configuration is foundation preparation and does not implement that split.

If consolidating later, the PostgreSQL 16 instance is the closest match to the prototype's declared version. Before changing it:

1. Confirm owner-controlled backup/restore and upgrade responsibilities, and test an isolated ChoreQuest restore.
2. Provision a separate `chorequest` database, a restricted runtime login (`NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`), and separate migration credentials. Restrict CONNECT/schema privileges so this login cannot access other application databases. Review effective PUBLIC grants rather than assuming a new login is isolated automatically.
3. Declare a shared external database network in both owning Compose configurations, using a unique stable DNS alias. Do not rely on a one-off `docker network connect` that disappears on recreation, nor open PostgreSQL on the host just for inter-container access.
4. Replace the dedicated Compose service/dependency/volume with a deliberate external-database configuration. Changing `DB_HOST` in the current `.env` alone does not switch Compose to a shared database.
5. Bound connection pools for API, worker, and migrations, verify authentication from the intended network, run versioned migrations, and test cross-application access denial.

PostgreSQL supports multiple databases per cluster; roles are cluster-wide, so access isolation requires explicit privileges. See the official [database overview](https://www.postgresql.org/docs/16/manage-ag-overview.html) and [role documentation](https://www.postgresql.org/docs/18/user-manag.html).

## Changes and limits

The existing containers, databases, roles, networks, and volumes were inspected read-only. No running service was stopped, recreated, or attached to a new network. ChoreQuest was not launched. The server repository and ignored environment file were prepared for the `foundation` branch. Resolve the foundation review's P1 findings before starting a real household deployment.
