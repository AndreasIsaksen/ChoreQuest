# ChoreQuest

ChoreQuest is a containerized household chore webapp for local-network deployment.

## Features

- Separate member profiles
- Chore calendar view with due dates, descriptions, and completion checkboxes
- Admin dashboard to assign chores per member
- Member request workflow for different chores, due date changes, and other updates
- PostgreSQL data storage in a separate container

## Tech Stack

- Node.js + Express + EJS
- PostgreSQL
- Docker Compose

## Run with Docker

1. Copy environment file:

   ```bash
   cp .env.example .env
   ```

2. Start services:

   ```bash
   docker compose up --build
   ```

3. Open: <http://localhost:3000>

Default seeded users (password for all users: `password123`):

- Admin: `admin`
- Members: `alex`, `sam`

## Local Development (without Docker)

1. Install dependencies:

   ```bash
   npm install
   ```

2. Ensure PostgreSQL is running and `db/init.sql` has been applied.
3. Set environment variables from `.env.example`.
4. Run:

   ```bash
   npm start
   ```

## Tests

Run targeted tests with:

```bash
npm test
```
