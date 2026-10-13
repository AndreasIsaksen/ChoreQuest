const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const { migrate } = require("../src/migrate");
const { createApp } = require("../src/server");
const { todayKey } = require("../src/helpers");

test("admins and members see future tasks in their plan and month calendar without generating them", { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const root = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = "upcoming_test_" + process.pid;
  await root.query(`CREATE SCHEMA ${schema}`);
  const db = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  t.after(async () => { await db.end(); await root.query(`DROP SCHEMA ${schema} CASCADE`); await root.end(); });
  await db.query(fs.readFileSync("db/init.sql", "utf8"));
  await migrate(db);
  const password = "upcoming-test-password";
  await db.query("UPDATE users SET password_hash=$1", [await bcrypt.hash(password, 4)]);
  const today = todayKey(), year = Number(today.slice(0, 4)) + 1;
  const month = `${year}-02`, starts = month + "-01", anchor = `${year}-01-31`;
  async function schedule(title, user, start, unit = "days", extra = {}) {
    return (await db.query(`INSERT INTO chore_series(title,user_id,starts_on,interval_count,interval_unit,points,active,cooperative,weekdays,removed_at)
      VALUES($1,$2,$3,1,$4,7,$5,$6,$7,$8) RETURNING id`,
    [title, user, start, unit, extra.active ?? true, extra.cooperative ?? false, extra.weekdays ?? null, extra.removed_at ?? null])).rows[0].id;
  }
  const daily = await schedule("Alex upcoming daily", 2, starts);
  const weekdays = await schedule("Sam upcoming weekdays", 3, starts, "weeks", { weekdays: [1, 3, 5] });
  const coop = await schedule("Shared upcoming weekly", null, anchor, "weeks", { cooperative: true });
  await db.query("INSERT INTO series_participants(series_id,user_id,points) VALUES($1,2,3),($1,3,13)", [coop]);
  const monthly = await schedule("Alex monthly anchor", 2, anchor, "months");
  const unassigned = await schedule("Unassigned upcoming daily", null, starts);
  await schedule("Paused future task", 2, starts, "days", { active: false });
  await schedule("Deleted future task", 3, starts, "days", { removed_at: new Date() });
  const current = await schedule("Støvsuging", 2, today, "weeks");
  const currentSam = await schedule("Støvsuging", 3, today, "weeks");
  const crossMonthTask = (await db.query("INSERT INTO chores(title,user_id,window_start,due_date,points) VALUES('Cross-month assigned task',2,$1,$2::date+5,4) RETURNING id,to_char(due_date,'YYYY-MM-DD') AS due", [anchor, starts])).rows[0];
  await db.query("INSERT INTO chores(title,user_id,due_date,points) VALUES('Future one-off task',2,$1::date+5,4)", [today]);
  const server = createApp({ db, env: { SESSION_SECRET: "upcoming-tests", SESSION_COOKIE_SECURE: "false" } }).listen(0);
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = "http://127.0.0.1:" + server.address().port;
  async function login(username) {
    const page = await fetch(base + "/login");
    const token = (await page.text()).match(/name="_csrf" value="([^"]+)"/)[1];
    const response = await fetch(base + "/login", { method: "POST", redirect: "manual",
      headers: { Cookie: page.headers.get("set-cookie").split(";")[0], "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username, password, _csrf: token }) });
    assert.equal(response.status, 302);
    return response.headers.get("set-cookie").split(";")[0];
  }
  const admin = await login("admin"), alex = await login("alex"), sam = await login("sam");
  async function page(cookie, query = "") {
    const response = await fetch(base + "/dashboard?" + query, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    return response.text();
  }
  // First load generates only the current window, as before.
  await page(admin);
  const currentTasks = (await db.query("SELECT id,user_id,to_char(due_date,'YYYY-MM-DD') AS due FROM chores WHERE series_id=ANY($1::int[])", [[current, currentSam]])).rows;
  assert.equal(currentTasks.length, 2);
  const cells = html => [...html.matchAll(/<div class="calendar-day[^\"]*">([\s\S]*?)<\/div>/g)].map(cell => ({
    date: cell[1].match(/datetime="([^\"]+)"/)[1],
    links: [...cell[1].matchAll(/href="#([^\"]+)"/g)].map(m => m[1]),
  }));
  // Each member's actual weekly task appears exactly once, on its deadline.
  for (const [cookie, userId] of [[admin, null], [alex, 2], [sam, 3]]) {
    for (const section of ["overview", "chores"]) {
      const html = await page(cookie, `section=${section}&view=calendar&month=${currentTasks[0].due.slice(0,7)}`);
      for (const task of currentTasks) {
        const dates = cells(html).filter(cell => cell.links.includes(`chore-${task.id}`)).map(cell => cell.date);
        assert.deepEqual(dates, userId === null || task.user_id === userId ? [task.due] : []);
      }
    }
  }
  const priorMonth = anchor.slice(0,7);
  const beforeDeadlineMonth = await page(admin, `section=chores&view=calendar&month=${priorMonth}`);
  assert.doesNotMatch(beforeDeadlineMonth, /Cross-month assigned task/);
  // Lists still show tasks spanning months with their complete date range.
  assert.match(await page(admin, "section=chores&view=list"), /Cross-month assigned task/);
  const deadlineMonth = await page(admin, `section=chores&view=calendar&month=${month}`);
  assert.deepEqual(cells(deadlineMonth).filter(cell => cell.links.includes(`chore-${crossMonthTask.id}`)).map(cell => cell.date), [crossMonthTask.due]);
  const before = (await db.query("SELECT id,generated_count FROM chore_series ORDER BY id")).rows;
  const taskCount = (await db.query("SELECT count(*) FROM chores")).rows[0].count;
  const ledgerCount = (await db.query("SELECT count(*) FROM point_ledger")).rows[0].count;
  const ids = html => [...html.matchAll(/id="upcoming-series-(\d+)-(\d{4}-\d{2}-\d{2})"/g)].map(m => `${m[1]}:${m[2]}`).sort();
  let adminCalendar;
  for (const [cookie, visible, hidden] of [
    [admin, [daily, weekdays, coop, monthly, unassigned, current, currentSam], []],
    [alex, [daily, coop, monthly, current], [weekdays, unassigned, currentSam]],
    [sam, [weekdays, coop, currentSam], [daily, monthly, unassigned, current]],
  ]) for (const section of ["overview", "chores"]) for (const view of ["list", "calendar"]) {
    const html = await page(cookie, `section=${section}&view=${view}&month=${month}`);
    for (const id of visible) assert.match(html, new RegExp(`id="upcoming-series-${id}"`));
    for (const id of hidden) assert.doesNotMatch(html, new RegExp(`id="upcoming-series-${id}"`));
    assert.doesNotMatch(html, /Paused future task|Deleted future task/);
    assert.ok(html.indexOf('id="upcoming-chores"') < html.indexOf('<aside class="right-column">'));
    const previews = ids(html);
    assert.equal(new Set(previews).size, previews.length);
    if (view === "list") {
      assert.equal(previews.length, visible.length);
      assert.doesNotMatch(html, new RegExp(`id="upcoming-series-${current}-${today}"`));
      if (cookie !== sam) assert.match(html, /Future one-off task/);
    } else {
      for (const preview of previews) assert.ok(html.includes(`href="#upcoming-series-${preview.replace(":", "-")}"`));
      if (cookie === admin) adminCalendar = html;
    }
  }
  assert.match(adminCalendar, /Alex Member: 3 points/);
  assert.match(adminCalendar, /Sam Member: 13 points/);
  assert.doesNotMatch(adminCalendar, /Assign the first chore/);
  for (const filter of ["status=completed", "status=overdue", "status=removed", "choreType=quick"]) {
    assert.deepEqual(ids(await page(admin, `section=chores&view=calendar&month=${month}&${filter}`)), []);
  }
  for (const status of ["all", "open"]) {
    const html = await page(admin, `section=chores&view=calendar&month=${month}&member=3&status=${status}&choreType=standard`);
    assert.match(html, new RegExp(`id="upcoming-series-${weekdays}"`));
    assert.match(html, new RegExp(`id="upcoming-series-${coop}"`));
    assert.doesNotMatch(html, new RegExp(`id="upcoming-series-${daily}"`));
    const unassignedPage = await page(admin, `section=chores&member=unassigned&status=${status}`);
    assert.deepEqual(ids(unassignedPage), [`${unassigned}:${starts}`]);
  }
  assert.deepEqual(ids(await page(admin, "section=chores&view=calendar&month=2000-01")), []);
  assert.deepEqual((await db.query("SELECT id,generated_count FROM chore_series ORDER BY id")).rows, before);
  assert.equal((await db.query("SELECT count(*) FROM chores")).rows[0].count, taskCount);
  assert.equal((await db.query("SELECT count(*) FROM point_ledger")).rows[0].count, ledgerCount);
  // Compare rendered previews with the real PostgreSQL generator, rolling back
  // the future generation so this check cannot alter subsequent assertions.
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT generate_chore_occurrences(($1::date + interval '1 month' - interval '1 day')::date)", [starts]);
    const actual = (await client.query(`SELECT series_id,to_char(window_start,'YYYY-MM-DD') AS start,to_char(due_date,'YYYY-MM-DD') AS due FROM chores
      WHERE series_id IS NOT NULL AND window_start>$1 AND due_date>=$2 AND due_date<($2::date+interval '1 month')`, [today, starts])).rows;
    assert.deepEqual(ids(adminCalendar), actual.map(c => `${c.series_id}:${c.start}`).sort());
    for (const cell of adminCalendar.matchAll(/<div class="calendar-day[^\"]*">([\s\S]*?)<\/div>/g)) {
      const date = cell[1].match(/datetime="([^\"]+)"/)[1];
      const links = [...cell[1].matchAll(/href="#upcoming-series-(\d+)-(\d{4}-\d{2}-\d{2})"/g)].map(m => `${m[1]}:${m[2]}`).sort();
      const expected = date.startsWith(month) ? actual.filter(c => c.due === date).map(c => `${c.series_id}:${c.start}`).sort() : [];
      assert.deepEqual(links, expected, `calendar previews on ${date}`);
    }
  } finally { await client.query("ROLLBACK"); client.release(); }
});
