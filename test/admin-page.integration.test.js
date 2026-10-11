const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const { migrate } = require("../src/migrate");
const { createApp } = require("../src/server");
const { todayKey } = require("../src/helpers");

test("admin schedule editing preserves history and redirects to the affected item", { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const root = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = "admin_page_test_" + process.pid;
  await root.query(`CREATE SCHEMA ${schema}`);
  const db = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  t.after(async () => { await db.end(); await root.query(`DROP SCHEMA ${schema} CASCADE`); await root.end(); });
  await db.query(fs.readFileSync("db/init.sql", "utf8"));
  await migrate(db);
  const password = "admin-page-test-password";
  await db.query("UPDATE users SET password_hash=$1", [await bcrypt.hash(password, 4)]);
  const server = createApp({ db, env: { SESSION_SECRET: "admin-page-tests", SESSION_COOKIE_SECURE: "false" } }).listen(0);
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = "http://127.0.0.1:" + server.address().port;
  const csrf = html => html.match(/name="_csrf" value="([^"]+)"/)[1];
  async function login(username) {
    const page = await fetch(base + "/login");
    const response = await fetch(base + "/login", { method: "POST", redirect: "manual",
      headers: { Cookie: page.headers.get("set-cookie").split(";")[0], "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username, password, _csrf: csrf(await page.text()) }),
    });
    const cookie = response.headers.get("set-cookie").split(";")[0];
    const html = await (await fetch(base + "/dashboard", { headers: { Cookie: cookie } })).text();
    return { cookie, token: csrf(html) };
  }
  const admin = await login("admin"), member = await login("alex");
  async function post(path, values, auth = admin) {
    const body = new URLSearchParams({ _csrf: auth.token });
    for (const [key, value] of Object.entries(values))
      for (const entry of Array.isArray(value) ? value : [value]) body.append(key, entry);
    return fetch(base + path, { method: "POST", redirect: "manual",
      headers: { Cookie: auth.cookie, "Content-Type": "application/x-www-form-urlencoded" }, body });
  }
  const day = n => { const d = new Date(todayKey() + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const created = await post("/admin/chores", { title: "Laundry", points: "10" });
  const template = (await db.query("SELECT * FROM chore_templates WHERE title='Laundry'")).rows[0];
  assert.equal(created.headers.get("location"), `/dashboard?section=administration#library-${template.id}`);
  const assigned = await post(`/admin/library/${template.id}/assign`, {
    mode: "individual", memberIds: ["2", "3"], individualPoints: "true", memberPoints_2: "5", memberPoints_3: "13",
    schedule: "recurring", startsOn: day(0), intervalCount: "1", intervalUnit: "days",
  });
  const schedules = (await db.query("SELECT * FROM chore_series WHERE template_id=$1 ORDER BY user_id", [template.id])).rows;
  const firstTask = (await db.query("SELECT * FROM chores WHERE series_id=$1", [schedules[0].id])).rows[0];
  assert.equal(assigned.headers.get("location"), `/dashboard?section=chores#chore-${firstTask.id}`);
  const page = await (await fetch(base + "/dashboard?section=administration", { headers: { Cookie: admin.cookie } })).text();
  assert.equal((page.match(/class="compact-item schedule-group"/g) || []).length, 1);
  assert.ok(page.includes("Alex Member: 5 points"));
  assert.ok(page.includes("Sam Member: 13 points"));
  assert.match(page, /class="compact-item library-card" id="library-\d+"><summary/);
  assert.match(page, /class="member-picker weekday-picker"/);
  const endpoint = `/admin/series/${schedules[0].id}`;
  const edit = { memberIds: ["2", "3"], mode: "cooperative", active: "true", points: "18" };
  const before = (await db.query("SELECT * FROM chore_series WHERE id=$1", [schedules[0].id])).rows[0];
  for (const invalid of [
    { mode: "other" }, { memberIds: ["2"] }, { memberIds: ["99999"] }, { active: "yes" },
    { points: "-1" }, { points: "1.5" }, { points: "1000001" }, { individualPoints: "false" },
    { individualPoints: "true", memberPoints_2: "5" },
    { individualPoints: "true", memberPoints_2: "5", memberPoints_3: "bad" },
  ]) assert.equal((await post(endpoint, { ...edit, ...invalid })).status, 400);
  assert.equal((await post(endpoint, edit, member)).status, 403);
  assert.deepEqual((await db.query("SELECT * FROM chore_series WHERE id=$1", [schedules[0].id])).rows[0], before);
  const changed = await post(endpoint, edit);
  assert.equal(changed.headers.get("location"), `/dashboard?section=administration#schedule-${schedules[0].id}`);
  assert.equal((await post(endpoint, { memberIds: ["2", "3"], active: "true" })).status, 302);
  assert.ok((await db.query("SELECT points FROM series_participants WHERE series_id=$1", [schedules[0].id])).rows.every(p => p.points === null));
  assert.deepEqual((await db.query("SELECT * FROM chores WHERE id=$1", [firstTask.id])).rows[0], firstTask);
  await db.query("SELECT generate_chore_occurrences($1::date)", [day(1)]);
  const sharedTask = (await db.query("SELECT * FROM chores WHERE series_id=$1 AND window_start=$2", [schedules[0].id, day(1)])).rows[0];
  assert.equal(sharedTask.cooperative, true);
  assert.deepEqual((await db.query("SELECT user_id,points FROM chore_member_points WHERE chore_id=$1 ORDER BY user_id", [sharedTask.id])).rows,
    [{ user_id: 2, points: 18 }, { user_id: 3, points: 18 }]);

  // Splitting a shared schedule copies the generation cursor and each member's reward.
  const split = await post(endpoint, { mode: "individual", memberIds: ["2", "3"], active: "true",
    individualPoints: "true", memberPoints_2: "7", memberPoints_3: "17" });
  assert.equal(split.status, 302);
  const copies = (await db.query("SELECT * FROM chore_series WHERE template_id=$1 AND id<>$2 ORDER BY id", [template.id, schedules[1].id])).rows;
  assert.equal(copies.length, 2);
  assert.ok(copies.every(s => !s.cooperative && s.generated_count === 2));
  assert.deepEqual(copies.map(s => [s.user_id, s.points]), [[2, 7], [3, 17]]);
  await db.query("SELECT generate_chore_occurrences($1::date)", [day(2)]);
  const future = (await db.query("SELECT user_id,points FROM chores WHERE series_id=ANY($1::int[]) AND window_start=$2 ORDER BY user_id", [copies.map(s => s.id), day(2)])).rows;
  assert.deepEqual(future, [{ user_id: 2, points: 7 }, { user_id: 3, points: 17 }]);
  assert.deepEqual((await db.query("SELECT * FROM chores WHERE id=$1", [sharedTask.id])).rows[0], sharedTask);
  assert.equal((await db.query("SELECT points FROM chore_templates WHERE id=$1", [template.id])).rows[0].points, 10);
  assert.equal((await db.query("SELECT * FROM chores WHERE series_id=$1 AND window_start<$2", [copies[1].id, day(2)])).rowCount, 0);

  // Shared points explicitly replace old custom rewards, including zero points.
  assert.equal((await post(endpoint, { ...edit, points: "0", active: "false" })).status, 302);
  assert.ok((await db.query("SELECT points FROM series_participants WHERE series_id=$1", [schedules[0].id])).rows.every(p => p.points === null));
  assert.equal((await post(endpoint, { ...edit, points: "0" })).status, 302);
  await db.query("SELECT generate_chore_occurrences($1::date)", [day(3)]);
  assert.deepEqual((await db.query("SELECT m.user_id,m.points FROM chore_member_points m JOIN chores c ON c.id=m.chore_id WHERE c.series_id=$1 AND c.window_start=$2 ORDER BY m.user_id", [schedules[0].id, day(3)])).rows,
    [{ user_id: 2, points: 0 }, { user_id: 3, points: 0 }]);
  assert.equal((await post(endpoint, { mode: "individual", active: "false", points: "9" })).status, 302);
  const unassigned = (await db.query("SELECT * FROM chore_series WHERE id=$1", [schedules[0].id])).rows[0];
  assert.equal(unassigned.user_id, null);
  assert.equal(unassigned.active, false);

  // Weekday schedules split with the same selected days and due time.
  await post(`/admin/library/${template.id}/assign`, { mode: "cooperative", memberIds: ["2", "3"], points: "11",
    schedule: "weekdays", weekdays: ["1", "3", "5"], startsOn: day(0), dueTime: "14:00" });
  const weekdays = (await db.query("SELECT * FROM chore_series WHERE weekdays IS NOT NULL")).rows[0];
  assert.equal((await post(`/admin/series/${weekdays.id}`, { mode: "individual", memberIds: ["2", "3"], active: "true", points: "12" })).status, 302);
  const weekdayCopies = (await db.query("SELECT * FROM chore_series WHERE weekdays IS NOT NULL ORDER BY id")).rows;
  assert.equal(weekdayCopies.length, 2);
  assert.ok(weekdayCopies.every(s => s.due_time === "14:00:00" && s.generated_count === 1 && !s.cooperative));
  assert.deepEqual(weekdayCopies.map(s => s.weekdays), [[1, 3, 5], [1, 3, 5]]);

  const returnTo = "/dashboard?section=chores&view=calendar&status=open&member=2&month=" + todayKey().slice(0, 7);
  const status = await post(`/admin/chores/${firstTask.id}/status`, { completed: "true", returnTo });
  assert.equal(status.headers.get("location"), returnTo + "#chore-" + firstTask.id);
  const external = await post(`/admin/chores/${firstTask.id}/status`, { completed: "false", returnTo: "https://example.com" });
  assert.equal(external.headers.get("location"), `/dashboard?section=chores#chore-${firstTask.id}`);
});
