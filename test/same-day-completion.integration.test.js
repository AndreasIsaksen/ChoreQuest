const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const { migrate } = require("../src/migrate");
const { createApp } = require("../src/server");
const { todayKey } = require("../src/helpers");

test("member completion closes after the due date and same-day completion earns full net points", { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const root = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = "same_day_test_" + process.pid;
  await root.query(`CREATE SCHEMA ${schema}`);
  const db = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  t.after(async () => { await db.end(); await root.query(`DROP SCHEMA ${schema} CASCADE`); await root.end(); });
  await db.query(fs.readFileSync("db/init.sql", "utf8"));
  await migrate(db);
  await migrate(db);
  const password = "same-day-test-password";
  await db.query("UPDATE users SET password_hash=$1", [await bcrypt.hash(password, 4)]);
  const today = todayKey();
  const day = n => { const d = new Date(today + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const server = createApp({ db, env: { SESSION_SECRET: "same-day-tests", SESSION_COOKIE_SECURE: "false" } }).listen(0);
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = "http://127.0.0.1:" + server.address().port;
  const csrf = html => html.match(/name="_csrf" value="([^"]+)"/)[1];
  async function login(username) {
    const page = await fetch(base + "/login");
    const response = await fetch(base + "/login", { method: "POST", redirect: "manual",
      headers: { Cookie: page.headers.get("set-cookie").split(";")[0], "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username, password, _csrf: csrf(await page.text()) }) });
    assert.equal(response.status, 302);
    const cookie = response.headers.get("set-cookie").split(";")[0];
    const html = await (await fetch(base + "/dashboard", { headers: { Cookie: cookie } })).text();
    return { cookie, token: csrf(html) };
  }
  const admin = await login("admin"), alex = await login("alex"), sam = await login("sam");
  async function post(id, body = { completed: "true" }, auth = alex, route = "chores") {
    return fetch(base + (route === "admin" ? `/admin/chores/${id}/status` : `/chores/${id}/toggle`), {
      method: "POST", redirect: "manual", headers: { Cookie: auth.cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: auth.token, ...body }) });
  }
  const ledger = async id => (await db.query("SELECT user_id,sum(amount)::int AS points FROM point_ledger WHERE chore_id=$1 GROUP BY user_id ORDER BY user_id", [id])).rows;
  async function chore(title, due = today, time = "00:00", extra = {}) {
    return (await db.query(`INSERT INTO chores(title,user_id,points,due_date,due_time,cooperative,is_quick,window_start,removed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [title, extra.cooperative ? null : 2, extra.points ?? 10, due, time, extra.cooperative ?? false, extra.quick ?? false, extra.start ?? null, extra.removed ?? null])).rows[0].id;
  }
  const card = (html, id) => html.match(new RegExp(`<article[^>]*id="chore-${id}"[\\s\\S]*?<\\/article>`))[0];

  await t.test("same-day late completion balances a processed deduction and cannot farm points", async () => {
    const id = await chore("Due today after due time");
    await db.query("SELECT process_points($1)", [today]);
    await db.query("SELECT process_points($1)", [today]);
    assert.deepEqual(await ledger(id), [{ user_id: 2, points: -10 }]);
    const html = await (await fetch(base + "/dashboard?status=overdue", { headers: { Cookie: alex.cookie } })).text();
    assert.doesNotMatch(card(html, id), /<button[^>]*disabled/);
    assert.match(card(html, id), /You can complete this chore today for full points/);
    const saved = await post(id, { completed: "true", returnTo: "/dashboard?section=chores&status=overdue" });
    assert.equal(saved.status, 302);
    assert.equal(saved.headers.get("location"), `/dashboard?section=chores&status=overdue#chore-${id}`);
    assert.deepEqual(await ledger(id), [{ user_id: 2, points: 10 }]);
    assert.deepEqual((await db.query("SELECT kind,amount FROM point_ledger WHERE chore_id=$1 ORDER BY id", [id])).rows,
      [{ kind: "overdue", amount: -10 }, { kind: "completion", amount: 20 }]);
    await Promise.all([post(id), post(id)]);
    assert.equal((await db.query("SELECT count(*)::int AS count FROM point_ledger WHERE chore_id=$1", [id])).rows[0].count, 2);
    assert.equal((await post(id, { completed: "false" })).status, 302);
    assert.deepEqual(await ledger(id), [{ user_id: 2, points: -10 }]);
    assert.equal((await post(id)).status, 302);
    assert.deepEqual(await ledger(id), [{ user_id: 2, points: 10 }]);
    const completed = await (await fetch(base + "/dashboard?status=completed", { headers: { Cookie: alex.cookie } })).text();
    assert.match(card(completed, id), /Done late/);
  });

  await t.test("shared completion captures unprocessed penalties and respects individual and zero rewards", async () => {
    const id = await chore("Shared overdue today", today, "00:00", { cooperative: true, points: 99 });
    await db.query("INSERT INTO chore_participants(chore_id,user_id,points) VALUES($1,2,5),($1,3,13)", [id]);
    assert.deepEqual(await ledger(id), []);
    await Promise.all([post(id), post(id, { completed: "true" }, sam)]);
    assert.deepEqual(await ledger(id), [{ user_id: 2, points: 5 }, { user_id: 3, points: 13 }]);
    assert.equal((await post(id, { completed: "false" }, sam)).status, 302);
    assert.deepEqual(await ledger(id), [{ user_id: 2, points: -5 }, { user_id: 3, points: -13 }]);
    await post(id);
    assert.deepEqual(await ledger(id), [{ user_id: 2, points: 5 }, { user_id: 3, points: 13 }]);
    const zero = await chore("Zero reward overdue today", today, "00:00", { points: 0 });
    assert.equal((await post(zero)).status, 302);
    assert.deepEqual(await ledger(zero), []);
  });

  await t.test("the same rule covers quick chores and generated interval and weekday tasks", async () => {
    const quick = await chore("Quick overdue today", today, "00:00", { quick: true, points: 6 });
    assert.equal((await post(quick)).status, 302);
    assert.deepEqual(await ledger(quick), [{ user_id: 2, points: 6 }]);
    for (const weekdays of [null, [new Date(today + "T12:00:00Z").getUTCDay() || 7]]) {
      const series = (await db.query(`INSERT INTO chore_series(title,user_id,points,starts_on,interval_count,interval_unit,weekdays,due_time)
        VALUES('Recurring due today',2,7,$1,$2,'days',$3,'00:00') RETURNING id`, [weekdays ? today : day(-2), weekdays ? 1 : 3, weekdays])).rows[0].id;
      await db.query("SELECT generate_chore_occurrences($1)", [today]);
      const task = (await db.query("SELECT id FROM chores WHERE series_id=$1 AND due_date=$2", [series, today])).rows[0].id;
      assert.equal((await post(task)).status, 302);
      assert.deepEqual(await ledger(task), [{ user_id: 2, points: 7 }]);
    }
  });

  await t.test("expired tasks reject both explicit and implicit completion while admins can correct them", async () => {
    for (const time of [null, "14:00"]) {
      const id = await chore("Expired completion", day(-1), time);
      const html = await (await fetch(base + "/dashboard", { headers: { Cookie: alex.cookie } })).text();
      assert.match(card(html, id), /<button disabled/);
      assert.match(card(html, id), /The completion day has ended/);
      const before = await ledger(id);
      for (const body of [{ completed: "true" }, {}]) assert.equal((await post(id, body)).status, 403);
      assert.equal((await db.query("SELECT completed FROM chores WHERE id=$1", [id])).rows[0].completed, false);
      assert.deepEqual(await ledger(id), before);
      assert.equal((await post(id, { completed: "true" }, admin, "admin")).status, 302);
      assert.deepEqual(await ledger(id), [{ user_id: 2, points: 10 }]);
    }
  });

  await t.test("undated and date-only tasks stay available and existing access restrictions apply", async () => {
    for (const due of [null, today]) {
      const id = await chore("Available completion", due, null);
      assert.equal((await post(id, { completed: "true" }, sam)).status, 403);
      assert.equal((await post(id)).status, 302);
      assert.deepEqual(await ledger(id), [{ user_id: 2, points: 10 }]);
    }
    for (const extra of [{ removed: new Date() }, { start: day(1) }]) {
      const id = await chore("Unavailable completion", day(1), null, extra);
      assert.equal((await post(id)).status, 403);
      assert.deepEqual(await ledger(id), []);
    }
  });

  await t.test("the cutoff is exactly Oslo midnight, including both daylight-saving transitions", async () => {
    for (const [due, before, after] of [
      ["2026-03-29", "2026-03-29T21:59:59.999999Z", "2026-03-29T22:00:00Z"],
      ["2026-10-25", "2026-10-25T22:59:59.999999Z", "2026-10-25T23:00:00Z"],
    ]) {
      const policy = (await db.query(`SELECT member_chore_completion_open($1,$2) AS before,
        member_chore_completion_open($1,$3) AS after, member_chore_completion_open(NULL,$3) AS undated`, [due, before, after])).rows[0];
      assert.deepEqual(policy, { before: true, after: false, undated: true });
    }
  });
});
