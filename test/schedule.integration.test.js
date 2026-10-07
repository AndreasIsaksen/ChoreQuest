const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const { migrate } = require("../src/migrate");
const { createApp } = require("../src/server");
const { todayKey, formatDate } = require("../src/helpers");

test("weekday schedules and timed deadlines", { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const root = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = "schedule_test_" + process.pid;
  await root.query(`CREATE SCHEMA ${schema}`);
  const db = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  t.after(async () => { await db.end(); await root.query(`DROP SCHEMA ${schema} CASCADE`); await root.end(); });
  await db.query(fs.readFileSync("db/init.sql", "utf8"));
  await migrate(db);
  await migrate(db);
  const password = "schedule-test-password";
  await db.query("UPDATE users SET password_hash=$1", [await bcrypt.hash(password, 4)]);
  const server = createApp({ db, env: { SESSION_SECRET: "schedule-test-secret", SESSION_COOKIE_SECURE: "false" } }).listen(0);
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = "http://127.0.0.1:" + server.address().port;
  const csrf = html => html.match(/name="_csrf" value="([^"]+)"/)[1];
  async function login(username) {
    let r = await fetch(base + "/login");
    let cookie = r.headers.get("set-cookie").split(";")[0];
    const token = csrf(await r.text());
    r = await fetch(base + "/login", { method: "POST", redirect: "manual", headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ username, password, _csrf: token }) });
    assert.equal(r.status, 302);
    cookie = r.headers.get("set-cookie").split(";")[0];
    const html = await (await fetch(base + "/dashboard", { headers: { Cookie: cookie } })).text();
    return { cookie, token: csrf(html) };
  }
  const admin = await login("admin"), member = await login("alex"), outsider = await login("sam");
  const template = (await db.query("INSERT INTO chore_templates(title,points) VALUES('Scheduled dishes',9) RETURNING id")).rows[0].id;
  async function assign(body, auth = admin) {
    const form = new URLSearchParams({ _csrf: auth.token });
    for (const [key,value] of Object.entries(body))
      for (const entry of Array.isArray(value) ? value : [value]) form.append(key, entry);
    return fetch(base + `/admin/library/${template}/assign`, { method: "POST", redirect: "manual", headers: { Cookie: auth.cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: form });
  }
  const monday = new Date(todayKey() + "T12:00:00Z");
  monday.setUTCDate(monday.getUTCDate() + ((8 - monday.getUTCDay()) % 7 || 7));
  const day = offset => { const d = new Date(monday); d.setUTCDate(d.getUTCDate()+offset); return d.toISOString().slice(0,10); };
  const plan = { schedule: "weekdays", memberIds: "2", startsOn: day(0), weekdays: ["1","3","5"], dueTime: "14:00" };
  for (const invalid of [ { weekdays: [] }, { weekdays: ["0"] }, { weekdays: ["8"] }, { weekdays: ["1","bad"] }, { dueTime: "24:00" }, { dueTime: "14:60" }, { dueTime: "2pm" }, { startsOn: "" } ])
    assert.equal((await assign({ ...plan, ...invalid })).status, 400);
  assert.equal((await assign(plan, member)).status, 403);
  assert.equal((await assign(plan)).status, 302);
  const series = (await db.query("SELECT * FROM chore_series")).rows[0];
  assert.deepEqual(series.weekdays, [1,3,5]);
  assert.equal(series.due_time, "14:00:00");
  assert.equal((await db.query("SELECT * FROM chores")).rowCount, 0);
  for (const auth of [admin,member]) {
    const html = await (await fetch(base + "/dashboard", { headers: { Cookie: auth.cookie } })).text();
    assert.match(html, /Mon, Wed, Fri · 14:00/);
  }
  assert.doesNotMatch(await (await fetch(base + "/dashboard", { headers: { Cookie: outsider.cookie } })).text(), /Scheduled dishes/);
  await Promise.all([db.query("SELECT generate_chore_occurrences($1)", [day(14)]), db.query("SELECT generate_chore_occurrences($1)", [day(14)])]);
  const tasks = (await db.query("SELECT id,to_char(window_start,'YYYY-MM-DD') AS start,to_char(due_date,'YYYY-MM-DD') AS due,due_time FROM chores WHERE series_id=$1 ORDER BY window_start", [series.id])).rows;
  assert.deepEqual(tasks.map(task=>task.start), [0,2,4,7,9,11,14].map(day));
  assert.ok(tasks.every(task=>task.start===task.due && task.due_time==="14:00:00"));
  await db.query("UPDATE chores SET removed_at=now() WHERE id=$1", [tasks[0].id]);
  await db.query("SELECT generate_chore_occurrences($1)", [day(14)]);
  assert.equal((await db.query("SELECT * FROM chores WHERE series_id=$1", [series.id])).rowCount, 7);
  await db.query("UPDATE chore_series SET active=false WHERE id=$1", [series.id]);
  await db.query("SELECT generate_chore_occurrences($1)", [day(21)]);
  assert.equal((await db.query("SELECT * FROM chores WHERE series_id=$1", [series.id])).rowCount, 7);
  await db.query("UPDATE chore_series SET active=true WHERE id=$1", [series.id]);
  await db.query("SELECT generate_chore_occurrences($1)", [day(21)]);
  assert.equal((await db.query("SELECT * FROM chores WHERE series_id=$1", [series.id])).rowCount, 10);
  assert.equal((await assign({ ...plan, startsOn: day(1), mode: "cooperative", memberIds: ["2","3"] })).status,302);
  const coop = (await db.query("SELECT id FROM chore_series WHERE cooperative")).rows[0].id;
  const futureHtml = await (await fetch(base + "/dashboard", { headers: { Cookie: member.cookie } })).text();
  assert.ok(futureHtml.includes("Next occurrence " + formatDate(day(2))));
  await db.query("SELECT generate_chore_occurrences($1)", [day(4)]);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM chore_members m JOIN chores c ON c.id=m.chore_id WHERE c.series_id=$1", [coop])).rows[0].n,4);
  assert.equal((await assign({ schedule: "once", memberIds: "2", dueTime: "14:00" })).status,400);
  assert.equal((await assign({ schedule: "once", memberIds: "2", dueDate: day(0), dueTime: "14:00" })).status,302);
  assert.equal((await db.query("SELECT due_time FROM chores WHERE series_id IS NULL")).rows[0].due_time,"14:00:00");
  assert.equal((await assign({ schedule: "recurring", memberIds: "2", startsOn: day(0), intervalCount: "2", intervalUnit: "weeks", dueTime: "14:00" })).status,302);
  await db.query("SELECT generate_chore_occurrences($1)", [day(0)]);
  const intervalTask = (await db.query("SELECT to_char(c.due_date,'YYYY-MM-DD') AS due,c.due_time FROM chores c JOIN chore_series s ON s.id=c.series_id WHERE s.weekdays IS NULL AND s.interval_count=2")).rows[0];
  assert.equal(intervalTask.due,day(13));
  assert.equal(intervalTask.due_time,"14:00:00");
  const offsets = (await db.query("SELECT chore_deadline('2026-03-29','14:00') AS summer,chore_deadline('2026-10-25','14:00') AS winter,chore_deadline('2026-10-25',NULL) AS end_day")).rows[0];
  assert.equal(offsets.summer.toISOString(),"2026-03-29T12:00:00.000Z");
  assert.equal(offsets.winter.toISOString(),"2026-10-25T13:00:00.000Z");
  assert.equal(offsets.end_day.toISOString(),"2026-10-25T23:00:00.000Z");
  const timed = (await db.query("INSERT INTO chores(user_id,title,points,due_date,due_time) VALUES(2,'Already due',9,((now()-interval '1 minute') AT TIME ZONE 'Europe/Oslo')::date,((now()-interval '1 minute') AT TIME ZONE 'Europe/Oslo')::time),(2,'Due later',9,((now()+interval '1 hour') AT TIME ZONE 'Europe/Oslo')::date,((now()+interval '1 hour') AT TIME ZONE 'Europe/Oslo')::time) RETURNING id")).rows;
  await db.query("SELECT process_points($1)",[todayKey()]);
  await db.query("SELECT process_points($1)",[todayKey()]);
  assert.deepEqual((await db.query("SELECT chore_id,amount FROM point_ledger WHERE chore_id=ANY($1::int[])",[timed.map(task=>task.id)])).rows,[{chore_id:timed[0].id,amount:-9}]);
  const overdueHtml = await (await fetch(base + "/dashboard?status=overdue", {headers:{Cookie:member.cookie}})).text();
  assert.match(overdueHtml,/Already due/);
  assert.doesNotMatch(overdueHtml,/Due later/);
  await db.query("UPDATE chores SET completed=true,completed_at=now() WHERE id=$1",[timed[0].id]);
  assert.match(await (await fetch(base + "/dashboard", {headers:{Cookie:member.cookie}})).text(),/Done late/);
});
