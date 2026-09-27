const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const { migrate } = require("../src/migrate");
const { createApp } = require("../src/server");
const { todayKey } = require("../src/helpers");

test(
  "admin accounts, unassigned chores and recurring windows against PostgreSQL",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const db = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    t.after(() => db.end());
    await db.query(fs.readFileSync("db/init.sql", "utf8"));
    await migrate(db);
    await migrate(db);
    const password = "integration-password-only";
    await db.query("UPDATE users SET password_hash=$1 WHERE username='admin'", [
      await bcrypt.hash(password, 4),
    ]);
    const server = createApp({
      db,
      env: {
        SESSION_SECRET: "integration-only-secret",
        SESSION_COOKIE_SECURE: "false",
      },
    }).listen(0, "0.0.0.0");
    await new Promise((resolve) => server.once("listening", resolve));
    t.after(
      () =>
        new Promise((resolve) => {
          server.close(resolve);
          server.closeAllConnections();
        }),
    );
    const base = "http://127.0.0.1:" + server.address().port;
    const csrf = (html) => html.match(/name="_csrf" value="([^"]+)"/)[1];
    async function login(username, pw = password) {
      let r = await fetch(base + "/login");
      let cookie = r.headers.get("set-cookie").split(";")[0];
      let token = csrf(await r.text());
      r = await fetch(base + "/login", {
        method: "POST",
        redirect: "manual",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ username, password: pw, _csrf: token }),
      });
      if (r.status !== 302) return { status: r.status };
      cookie = r.headers.get("set-cookie").split(";")[0];
      r = await fetch(base + "/dashboard", { headers: { Cookie: cookie } });
      token = csrf(await r.text());
      return { cookie, token };
    }
    async function post(path, body, auth) {
      const r = await fetch(base + path, {
        method: "POST",
        redirect: "manual",
        headers: {
          Cookie: auth.cookie,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ ...body, _csrf: auth.token }),
      });
      return r;
    }
    const admin = await login("admin");
    assert.equal(
      (
        await post(
          "/admin/users",
          {
            username: "new.member",
            displayName: "New Member",
            role: "member",
            password,
          },
          admin,
        )
      ).status,
      302,
    );
    assert.equal(
      (
        await post(
          "/admin/users",
          {
            username: "NEW.MEMBER",
            displayName: "Duplicate",
            role: "member",
            password,
          },
          admin,
        )
      ).status,
      409,
    );
    const memberId = (
      await db.query("SELECT id FROM users WHERE username='new.member'")
    ).rows[0].id;
    const member = await login("new.member");
    assert.equal(
      (
        await post(
          "/admin/users",
          { username: "intruder", displayName: "No", role: "admin", password },
          member,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await post(
          "/admin/chores",
          {
            title: "Unassigned task",
            schedule: "once",
            userId: "",
            dueDate: "",
          },
          admin,
        )
      ).status,
      302,
    );
    let chore = (
      await db.query("SELECT * FROM chores WHERE title='Unassigned task'")
    ).rows[0];
    assert.equal(chore.user_id, null);
    assert.equal(chore.due_date, null);
    assert.equal(
      (
        await post(
          `/admin/chores/${chore.id}/assign`,
          { userId: memberId },
          admin,
        )
      ).status,
      302,
    );
    assert.equal(
      (await post(`/chores/${chore.id}/toggle`, {}, member)).status,
      302,
    );
    assert.equal(
      (await db.query("SELECT completed FROM chores WHERE id=$1", [chore.id]))
        .rows[0].completed,
      true,
    );
    assert.equal(
      (
        await post(
          "/admin/chores",
          {
            title: "Weekly window",
            schedule: "recurring",
            userId: memberId,
            startsOn: todayKey(),
            intervalCount: "2",
            intervalUnit: "weeks",
          },
          admin,
        )
      ).status,
      302,
    );
    const series = (
      await db.query("SELECT * FROM chore_series WHERE title='Weekly window'")
    ).rows[0];
    let windows = (
      await db.query(
        "SELECT *, due_date-window_start AS days FROM chores WHERE series_id=$1",
        [series.id],
      )
    ).rows;
    assert.equal(windows.length, 1);
    assert.equal(windows[0].days, 13);
    await db.query(
      "UPDATE chores SET completed=true,completed_at=now() WHERE id=$1",
      [windows[0].id],
    );
    const later = new Date(todayKey() + "T12:00:00Z");
    later.setUTCDate(later.getUTCDate() + 30);
    await Promise.all([
      db.query("SELECT generate_chore_occurrences($1)", [
        later.toISOString().slice(0, 10),
      ]),
      db.query("SELECT generate_chore_occurrences($1)", [
        later.toISOString().slice(0, 10),
      ]),
    ]);
    windows = (
      await db.query(
        "SELECT * FROM chores WHERE series_id=$1 ORDER BY window_start",
        [series.id],
      )
    ).rows;
    assert.equal(windows.length, 3);
    assert.equal(windows[0].completed, true);
    assert.equal(windows[1].completed, false);
    const monthly = (
      await db.query(
        "INSERT INTO chore_series(title,starts_on,interval_count,interval_unit) VALUES('Monthly anchor','2028-01-31',1,'months') RETURNING id",
      )
    ).rows[0];
    await db.query("SELECT generate_chore_occurrences('2028-03-31')");
    const months = (
      await db.query(
        "SELECT to_char(window_start,'YYYY-MM-DD') AS start,to_char(due_date,'YYYY-MM-DD') AS last FROM chores WHERE series_id=$1 ORDER BY window_start",
        [monthly.id],
      )
    ).rows;
    assert.deepEqual(months, [
      { start: "2028-01-31", last: "2028-02-28" },
      { start: "2028-02-29", last: "2028-03-30" },
      { start: "2028-03-31", last: "2028-04-29" },
    ]);
    assert.equal(
      (
        await post(
          "/admin/chores",
          {
            title: "Bad recurrence",
            schedule: "recurring",
            startsOn: todayKey(),
            intervalCount: 0,
            intervalUnit: "weeks",
          },
          admin,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await post(
          "/admin/users/1",
          { action: "remove", confirmUsername: "admin" },
          admin,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await post(
          "/admin/users/1",
          { action: "save", displayName: "Admin", role: "member" },
          admin,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await post(
          `/admin/users/${memberId}`,
          { action: "remove", confirmUsername: "wrong" },
          admin,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await post(
          `/admin/users/${memberId}`,
          {
            action: "save",
            displayName: "Changed",
            role: "member",
            password: "replacement-password-only",
          },
          admin,
        )
      ).status,
      302,
    );
    let r = await fetch(base + "/dashboard", {
      redirect: "manual",
      headers: { Cookie: member.cookie },
    });
    assert.equal(r.headers.get("location"), "/login");
    assert.equal((await login("new.member")).status, 401);
    const refreshed = await login("new.member", "replacement-password-only");
    assert.ok(refreshed.cookie);
    assert.equal(
      (
        await post(
          `/admin/users/${memberId}`,
          { action: "remove", confirmUsername: "new.member" },
          admin,
        )
      ).status,
      302,
    );
    assert.equal(
      (await login("new.member", "replacement-password-only")).status,
      401,
    );
    r = await fetch(base + "/dashboard", {
      redirect: "manual",
      headers: { Cookie: refreshed.cookie },
    });
    assert.equal(r.headers.get("location"), "/login");
    assert.equal(
      (
        await db.query("SELECT user_id FROM chore_series WHERE id=$1", [
          series.id,
        ])
      ).rows[0].user_id,
      null,
    );
    assert.equal(
      (await db.query("SELECT user_id FROM chores WHERE id=$1", [chore.id]))
        .rows[0].user_id,
      memberId,
    );
    assert.equal(
      (await post(`/admin/users/${memberId}`, { action: "restore" }, admin))
        .status,
      302,
    );
    assert.ok((await login("new.member", "replacement-password-only")).cookie);
    for (const section of ["chores", "household", "requests"]) {
      r = await fetch(base + "/dashboard?section=" + section, {
        headers: { Cookie: admin.cookie },
      });
      assert.equal(r.status, 200);
    }
  },
);
