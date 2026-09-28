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
    await db.query(
      "INSERT INTO chores(user_id,title,due_date,completed) VALUES(2,'Existing chore','2026-01-01',true)",
    );
    await migrate(db);
    await migrate(db);
    assert.equal(
      (
        await db.query(
          "SELECT c.completed,t.title FROM chores c JOIN chore_templates t ON t.id=c.template_id WHERE c.title='Existing chore'",
        )
      ).rows[0].completed,
      true,
    );
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
      const form = new URLSearchParams({ _csrf: auth.token });
      for (const [key, value] of Object.entries(body))
        for (const entry of Array.isArray(value) ? value : [value])
          form.append(key, entry);
      const r = await fetch(base + path, {
        method: "POST",
        redirect: "manual",
        headers: {
          Cookie: auth.cookie,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form,
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
    // Definitions survive repeated assignments, and never create a task by themselves.
    assert.equal(
      (
        await post(
          "/admin/chores",
          { title: "Reusable laundry", description: "Own clothes" },
          admin,
        )
      ).status,
      302,
    );
    const laundry = (
      await db.query(
        "SELECT * FROM chore_templates WHERE title='Reusable laundry'",
      )
    ).rows[0];
    assert.equal(
      (
        await db.query("SELECT * FROM chores WHERE template_id=$1", [
          laundry.id,
        ])
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await post(
          `/admin/library/${laundry.id}/assign`,
          { memberIds: [memberId, 2], mode: "individual", schedule: "once" },
          member,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await post(
          `/admin/library/${laundry.id}/assign`,
          { memberIds: [memberId, 2], mode: "individual", schedule: "once" },
          admin,
        )
      ).status,
      302,
    );
    let tasks = (
      await db.query(
        "SELECT * FROM chores WHERE template_id=$1 ORDER BY user_id",
        [laundry.id],
      )
    ).rows;
    assert.equal(tasks.length, 2);
    const mine = tasks.find((c) => c.user_id === memberId);
    const other = tasks.find((c) => c.user_id === 2);
    assert.equal(
      (await post(`/chores/${mine.id}/toggle`, { completed: "true" }, member))
        .status,
      302,
    );
    assert.equal(
      (await db.query("SELECT completed FROM chores WHERE id=$1", [other.id]))
        .rows[0].completed,
      false,
    );
    assert.equal(
      (await post(`/chores/${other.id}/toggle`, { completed: "true" }, member))
        .status,
      403,
    );
    assert.equal(
      (
        await post(
          `/admin/library/${laundry.id}/assign`,
          { memberIds: [memberId], mode: "individual", schedule: "once" },
          admin,
        )
      ).status,
      302,
    );
    assert.equal(
      (
        await db.query("SELECT * FROM chore_templates WHERE id=$1", [
          laundry.id,
        ])
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await db.query("SELECT * FROM chores WHERE template_id=$1", [
          laundry.id,
        ])
      ).rowCount,
      3,
    );
    assert.equal(
      (
        await post(
          `/admin/library/${laundry.id}/assign`,
          { memberIds: [memberId], mode: "cooperative", schedule: "once" },
          admin,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await post(
          `/admin/library/${laundry.id}/assign`,
          {
            memberIds: [memberId, 999999],
            mode: "individual",
            schedule: "once",
          },
          admin,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await db.query("SELECT * FROM chores WHERE template_id=$1", [
          laundry.id,
        ])
      ).rowCount,
      3,
    );
    assert.equal(
      (
        await post(
          `/admin/library/${laundry.id}/assign`,
          { startsOn: "2028-02-10", dueDate: "2028-02-01", schedule: "once" },
          admin,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await post(
          "/admin/chores",
          { title: "Make dinner", points: "10" },
          admin,
        )
      ).status,
      302,
    );
    for (const points of ["-1", "1.5", "1000001", "abc", ""]) {
      assert.equal(
        (
          await post(
            "/admin/chores",
            { title: "Invalid points", points },
            admin,
          )
        ).status,
        400,
      );
    }
    const dinner = (
      await db.query("SELECT * FROM chore_templates WHERE title='Make dinner'")
    ).rows[0];
    assert.equal(
      (
        await post(
          `/admin/library/${dinner.id}/assign`,
          {
            memberIds: [memberId, 2],
            mode: "cooperative",
            schedule: "once",
            startsOn: todayKey(),
          },
          admin,
        )
      ).status,
      302,
    );
    const shared = (
      await db.query("SELECT * FROM chores WHERE template_id=$1", [dinner.id])
    ).rows[0];
    assert.equal(shared.cooperative, true);
    assert.equal(shared.points, 10);
    assert.equal(
      (
        await post(
          `/admin/library/${dinner.id}`,
          { title: "Tampered", points: 100 },
          member,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await db.query("SELECT * FROM chore_members WHERE chore_id=$1", [
          shared.id,
        ])
      ).rowCount,
      2,
    );
    await db.query(
      "UPDATE users SET password_hash=$1 WHERE username IN ('alex','sam')",
      [await bcrypt.hash(password, 4)],
    );
    const alex = await login("alex");
    const sam = await login("sam");
    for (const auth of [member, alex]) {
      const html = await (
        await fetch(base + "/dashboard", { headers: { Cookie: auth.cookie } })
      ).text();
      assert.match(html, /Make dinner/);
      assert.match(html, /Co-op chore/);
      assert.match(html, /Alex Member, New Member/);
    }
    const adminLibrary = await (
      await fetch(base + "/dashboard?section=administration", {
        headers: { Cookie: admin.cookie },
      })
    ).text();
    assert.match(adminLibrary, /name="points"/);
    assert.match(adminLibrary, /10 points per member/);
    const outsiderHtml = await (
      await fetch(base + "/dashboard", { headers: { Cookie: sam.cookie } })
    ).text();
    assert.doesNotMatch(outsiderHtml, /Make dinner/);
    assert.equal(
      (await post(`/chores/${shared.id}/toggle`, { completed: "true" }, sam))
        .status,
      403,
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM point_ledger WHERE chore_id=$1",
          [shared.id],
        )
      ).rows[0].n,
      0,
    );
    // Two members completing from stale pages must not toggle the shared task back open.
    await Promise.all([
      post(`/chores/${shared.id}/toggle`, { completed: "true" }, member),
      post(`/chores/${shared.id}/toggle`, { completed: "true" }, alex),
    ]);
    assert.equal(
      (await db.query("SELECT completed FROM chores WHERE id=$1", [shared.id]))
        .rows[0].completed,
      true,
    );
    assert.deepEqual(
      (
        await db.query(
          "SELECT user_id,amount FROM point_ledger WHERE chore_id=$1 ORDER BY user_id",
          [shared.id],
        )
      ).rows,
      [
        { user_id: 2, amount: 10 },
        { user_id: memberId, amount: 10 },
      ],
    );
    assert.equal(
      (
        await post(
          "/requests",
          {
            choreId: shared.id,
            requestType: "other",
            details: "Shared chore request",
          },
          alex,
        )
      ).status,
      302,
    );
    assert.equal(
      (
        await post(
          "/requests",
          {
            choreId: shared.id,
            requestType: "other",
            details: "Not a participant",
          },
          sam,
        )
      ).status,
      403,
    );
    const filtered = await (
      await fetch(base + "/dashboard?member=2", {
        headers: { Cookie: admin.cookie },
      })
    ).text();
    assert.match(filtered, new RegExp('id="chore-' + shared.id + '"'));
    const unassigned = await (
      await fetch(base + "/dashboard?member=unassigned", {
        headers: { Cookie: admin.cookie },
      })
    ).text();
    assert.doesNotMatch(unassigned, new RegExp('id="chore-' + shared.id + '"'));
    assert.equal(
      (
        await post(
          `/admin/library/${dinner.id}/assign`,
          {
            memberIds: [memberId, 2],
            mode: "cooperative",
            schedule: "recurring",
            points: "20",
            startsOn: todayKey(),
            intervalCount: 1,
            intervalUnit: "weeks",
          },
          admin,
        )
      ).status,
      302,
    );
    const coopSeries = (
      await db.query("SELECT * FROM chore_series WHERE template_id=$1", [
        dinner.id,
      ])
    ).rows[0];
    await db.query("SELECT generate_chore_occurrences($1::date+7)", [
      todayKey(),
    ]);
    const coopWindows = (
      await db.query(
        "SELECT c.id,count(m.user_id)::int AS members FROM chores c JOIN chore_members m ON m.chore_id=c.id WHERE c.series_id=$1 GROUP BY c.id",
        [coopSeries.id],
      )
    ).rows;
    assert.equal(coopSeries.points, 20);
    assert.equal(
      (
        await db.query("SELECT points FROM chore_templates WHERE id=$1", [
          dinner.id,
        ])
      ).rows[0].points,
      20,
    );
    assert.equal(
      (await db.query("SELECT points FROM chores WHERE id=$1", [shared.id]))
        .rows[0].points,
      10,
    );
    assert.equal(coopWindows.length, 2);
    assert.ok(coopWindows.every((c) => c.members === 2));
    assert.equal(
      (
        await post(
          `/admin/series/${coopSeries.id}`,
          { memberIds: [memberId, 3], active: "true" },
          admin,
        )
      ).status,
      302,
    );
    await db.query("SELECT generate_chore_occurrences($1::date+14)", [
      todayKey(),
    ]);
    const nextGroup = (
      await db.query(
        "SELECT m.user_id FROM chore_members m JOIN chores c ON c.id=m.chore_id WHERE c.series_id=$1 AND c.window_start=$2::date+14 ORDER BY m.user_id",
        [coopSeries.id, todayKey()],
      )
    ).rows.map((r) => r.user_id);
    assert.deepEqual(
      nextGroup,
      [3, memberId].sort((a, b) => a - b),
    );
    assert.equal(
      (
        await db.query("SELECT * FROM chore_members WHERE chore_id=$1", [
          coopWindows[0].id,
        ])
      ).rowCount,
      2,
    );
    assert.equal(
      (
        await post(
          `/admin/library/${dinner.id}`,
          {
            title: "Make a meal",
            description: "Updated definition",
            points: "30",
          },
          admin,
        )
      ).status,
      302,
    );
    assert.equal(
      (await db.query("SELECT title FROM chores WHERE id=$1", [shared.id]))
        .rows[0].title,
      "Make dinner",
    );
    assert.equal(
      (
        await post(
          `/admin/library/${laundry.id}/assign`,
          { memberIds: [memberId], schedule: "once", startsOn: "2099-01-01" },
          admin,
        )
      ).status,
      302,
    );
    const future = (
      await db.query(
        "SELECT id FROM chores WHERE template_id=$1 AND window_start='2099-01-01'",
        [laundry.id],
      )
    ).rows[0];
    assert.equal(
      (await post(`/chores/${future.id}/toggle`, { completed: "true" }, member))
        .status,
      403,
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
    for (const [table, column] of [
      ["users", "id"],
      ["chores", "user_id"],
      ["chore_series", "user_id"],
      ["chore_participants", "user_id"],
      ["series_participants", "user_id"],
      ["point_accounts", "user_id"],
      ["point_ledger", "user_id"],
      ["chore_requests", "user_id"],
    ]) {
      assert.equal(
        (
          await db.query(`SELECT * FROM ${table} WHERE ${column}=$1`, [
            memberId,
          ])
        ).rowCount,
        0,
      );
    }
    assert.equal(
      (await db.query("SELECT * FROM chores WHERE id=$1", [shared.id]))
        .rowCount,
      1,
    );
    assert.equal(
      (await db.query("SELECT * FROM chores WHERE id=$1", [chore.id])).rowCount,
      0,
    );
    assert.equal(
      (await db.query("SELECT * FROM chore_series WHERE id=$1", [series.id]))
        .rowCount,
      0,
    );
    r = await fetch(base + "/dashboard", {
      redirect: "manual",
      headers: { Cookie: refreshed.cookie },
    });
    assert.equal(r.headers.get("location"), "/login");
    assert.equal(
      (await post(`/admin/users/${memberId}`, { action: "restore" }, admin))
        .status,
      404,
    );
    for (const section of ["chores", "household", "requests"]) {
      r = await fetch(base + "/dashboard?section=" + section, {
        headers: { Cookie: admin.cookie },
      });
      assert.equal(r.status, 200);
    }
  },
);
