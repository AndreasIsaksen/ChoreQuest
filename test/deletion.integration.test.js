const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const { migrate } = require("../src/migrate");
const { createApp } = require("../src/server");
const { todayKey } = require("../src/helpers");

test(
  "deletion preserves chore history and points but permanently erases members",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const root = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = "deletion_test_" + process.pid;
    await root.query(`CREATE SCHEMA ${schema}`);
    const db = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    t.after(async () => {
      await db.end();
      await root.query(`DROP SCHEMA ${schema} CASCADE`);
      await root.end();
    });
    await db.query(fs.readFileSync("db/init.sql", "utf8"));
    await migrate(db);
    await migrate(db);
    const password = "disposable-delete-test";
    await db.query("UPDATE users SET password_hash=$1", [
      await bcrypt.hash(password, 4),
    ]);
    const server = createApp({
      db,
      env: {
        SESSION_SECRET: "deletion-tests-only",
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
    async function login(username) {
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
        body: new URLSearchParams({ username, password, _csrf: token }),
      });
      assert.equal(r.status, 302);
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
        body: new URLSearchParams({ _csrf: auth.token, ...body }),
      });
      return r.status;
    }
    const admin = await login("admin"),
      alex = await login("alex"),
      sam = await login("sam");
    const today = todayKey();
    const yesterday = new Date(today + "T12:00:00Z");
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const past = yesterday.toISOString().slice(0, 10);
    const template = (
      await db.query(
        "INSERT INTO chore_templates(title,points) VALUES('Delete library test',10) RETURNING id",
      )
    ).rows[0].id;
    async function chore(title, due, user = 2, cooperative = false) {
      return (
        await db.query(
          "INSERT INTO chores(title,due_date,user_id,cooperative,template_id,points) VALUES($1,$2,$3,$4,$5,10) RETURNING id",
          [title, due, user, cooperative, template],
        )
      ).rows[0].id;
    }
    const done = await chore("Done history", today);
    const overdue = await chore("Overdue history", past);
    const pending = await chore("Due today cancelled", today);
    const undated = await chore("No deadline cancelled", null);
    const doneUndated = await chore("Completed without deadline", null);
    const shared = await chore("Shared history", today, null, true);
    await db.query("INSERT INTO chore_participants VALUES($1,2),($1,3)", [
      shared,
    ]);
    for (const id of [done, doneUndated, shared])
      assert.equal(
        await post(`/chores/${id}/toggle`, { completed: "true" }, alex),
        302,
      );
    const recurring = (
      await db.query(
        "INSERT INTO chore_series(title,template_id,user_id,starts_on,interval_count,interval_unit,points) VALUES('Recurring deleted',$1,2,$2,1,'days',10) RETURNING id",
        [template, today],
      )
    ).rows[0].id;
    await db.query("SELECT generate_chore_occurrences($1::date)", [today]);
    const current = (
      await db.query("SELECT id FROM chores WHERE series_id=$1", [recurring])
    ).rows[0].id;
    const balance = async (id) =>
      (
        await db.query(
          "SELECT (weekly_points+permanent_points)::text AS total FROM member_points WHERE user_id=$1",
          [id],
        )
      ).rows[0].total;
    const alexBefore = await balance(2),
      samBefore = await balance(3);
    assert.equal(alexBefore, "20");
    assert.equal(samBefore, "10");
    assert.equal(
      await post(
        `/admin/library/${template}/delete`,
        { confirmTitle: "Delete library test" },
        alex,
      ),
      403,
    );
    assert.equal(
      await post(
        `/admin/library/${template}/delete`,
        { confirmTitle: "wrong" },
        admin,
      ),
      400,
    );
    assert.equal(
      await post(
        `/admin/library/${template}/delete`,
        { confirmTitle: "Delete library test", _csrf: "wrong" },
        admin,
      ),
      403,
    );
    assert.equal(
      await post(
        `/admin/library/${template}/delete`,
        { confirmTitle: "Delete library test" },
        admin,
      ),
      302,
    );
    const rows = (
      await db.query(
        "SELECT id,removed_at,removed_history FROM chores WHERE template_id=$1",
        [template],
      )
    ).rows;
    for (const row of rows) {
      assert.ok(row.removed_at);
      assert.equal(
        row.removed_history,
        [done, overdue, doneUndated, shared].includes(row.id),
      );
    }
    assert.equal(
      (
        await db.query("SELECT active FROM chore_series WHERE id=$1", [
          recurring,
        ])
      ).rows[0].active,
      false,
    );
    await db.query("SELECT generate_chore_occurrences($1::date+30)", [today]);
    await db.query("SELECT process_points($1::date+30)", [today]);
    assert.equal(
      (await db.query("SELECT id FROM chores WHERE series_id=$1", [recurring]))
        .rowCount,
      1,
    );
    assert.equal(await balance(2), alexBefore);
    assert.equal(await balance(3), samBefore);
    assert.equal(
      await post(`/chores/${done}/toggle`, { completed: "false" }, alex),
      403,
    );
    assert.equal(
      await post(`/admin/chores/${overdue}/assign`, { userId: 3 }, admin),
      409,
    );
    assert.equal(
      await post(`/admin/series/${recurring}`, { active: "true" }, admin),
      404,
    );
    assert.equal(
      await post(
        `/admin/library/${template}/assign`,
        { schedule: "once" },
        admin,
      ),
      404,
    );
    assert.equal(
      await post(
        `/admin/library/${template}`,
        { title: "Revive", points: 1 },
        admin,
      ),
      404,
    );
    assert.equal(
      await post(
        "/requests",
        {
          choreId: overdue,
          requestType: "other",
          details: "Change removed task",
        },
        alex,
      ),
      403,
    );
    let html = await (
      await fetch(base + "/dashboard?section=chores", {
        headers: { Cookie: alex.cookie },
      })
    ).text();
    for (const id of [pending, undated, current])
      assert.doesNotMatch(html, new RegExp('id="chore-' + id + '"'));
    for (const id of [done, overdue, doneUndated, shared])
      assert.match(html, new RegExp('id="chore-' + id + '"'));
    assert.match(html, /Removed/);
    html = await (
      await fetch(
        base +
          "/dashboard?section=chores&view=calendar&month=" +
          today.slice(0, 7),
        { headers: { Cookie: alex.cookie } },
      )
    ).text();
    assert.match(html, /Completed without deadline/);
    assert.match(html, / · Removed/);
    // Deleting a single occurrence preserves the recurring slot but permits the next period.
    const solo = (
      await db.query(
        "INSERT INTO chore_series(title,user_id,starts_on,interval_count,interval_unit) VALUES('Solo period',3,$1,1,'days') RETURNING id",
        [today],
      )
    ).rows[0].id;
    await db.query("SELECT generate_chore_occurrences($1::date)", [today]);
    const slot = (
      await db.query("SELECT id FROM chores WHERE series_id=$1", [solo])
    ).rows[0].id;
    assert.equal(
      await post(
        `/admin/chores/${slot}/delete`,
        { confirmTitle: "Solo period" },
        admin,
      ),
      302,
    );
    await db.query("SELECT generate_chore_occurrences($1::date+1)", [today]);
    assert.equal(
      (await db.query("SELECT id FROM chores WHERE series_id=$1", [solo]))
        .rowCount,
      2,
    );
    assert.equal(
      await post(
        `/admin/series/${solo}/delete`,
        { confirmTitle: "Solo period" },
        admin,
      ),
      302,
    );
    await db.query("SELECT generate_chore_occurrences($1::date+5)", [today]);
    assert.equal(
      (await db.query("SELECT id FROM chores WHERE series_id=$1", [solo]))
        .rowCount,
      2,
    );
    const survivingSeries = (
      await db.query(
        "INSERT INTO chore_series(title,user_id,starts_on,interval_count,interval_unit) VALUES('Surviving schedule',3,$1,1,'days') RETURNING id",
        [today],
      )
    ).rows[0].id;
    await db.query("SELECT generate_chore_occurrences($1::date)", [today]);
    await db.query("UPDATE chores SET user_id=2 WHERE series_id=$1", [
      survivingSeries,
    ]);
    // Permanent deletion clears even removed history and co-op participation, without touching Sam's points.
    await db.query(
      "INSERT INTO chore_requests(user_id,chore_id,request_type,details) VALUES(2,$1,'other','Private request')",
      [done],
    );
    assert.equal(
      await post(
        "/admin/users/2",
        { action: "remove", confirmUsername: "wrong" },
        admin,
      ),
      400,
    );
    assert.equal(
      await post(
        "/admin/users/1",
        { action: "remove", confirmUsername: "admin" },
        admin,
      ),
      400,
    );
    assert.equal(
      await post(
        "/admin/users/2",
        { action: "remove", confirmUsername: "alex" },
        sam,
      ),
      403,
    );
    assert.equal(
      await post(
        "/admin/users/2",
        { action: "remove", confirmUsername: "alex" },
        admin,
      ),
      302,
    );
    for (const [table, column] of [
      ["users", "id"],
      ["chores", "user_id"],
      ["chore_series", "user_id"],
      ["point_accounts", "user_id"],
      ["point_ledger", "user_id"],
      ["chore_participants", "user_id"],
      ["series_participants", "user_id"],
      ["chore_requests", "user_id"],
    ])
      assert.equal(
        (await db.query(`SELECT * FROM ${table} WHERE ${column}=2`)).rowCount,
        0,
      );
    assert.equal(
      (await db.query("SELECT id FROM chores WHERE id=$1", [done])).rowCount,
      0,
    );
    assert.equal(
      (await db.query("SELECT id FROM chores WHERE id=$1", [shared])).rowCount,
      1,
    );
    assert.equal(await balance(3), samBefore);
    await db.query("SELECT generate_chore_occurrences($1::date+1)", [today]);
    const survivingTasks = (
      await db.query(
        "SELECT to_char(window_start,'YYYY-MM-DD') AS day FROM chores WHERE series_id=$1",
        [survivingSeries],
      )
    ).rows;
    assert.equal(survivingTasks.length, 1);
    assert.notEqual(survivingTasks[0].day, today);
    const revoked = await fetch(base + "/dashboard", {
      redirect: "manual",
      headers: { Cookie: alex.cookie },
    });
    assert.equal(revoked.headers.get("location"), "/login");
    assert.equal(
      await post("/admin/users/2", { action: "restore" }, admin),
      404,
    );
    assert.equal(
      await post(
        "/admin/users",
        { username: "alex", displayName: "New Alex", password, role: "member" },
        admin,
      ),
      302,
    );
    const newAlex = (
      await db.query("SELECT id FROM users WHERE username='alex'")
    ).rows[0].id;
    assert.notEqual(newAlex, 2);
    assert.equal(await balance(newAlex), "0");
  },
);
