const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const { migrate } = require('../src/migrate');
const { createApp } = require('../src/server');
const { todayKey, choreHistoryStart } = require('../src/helpers');

test('history cutoffs count calendar days across month, year, leap-day and DST boundaries', () => {
  assert.equal(choreHistoryStart('1', '2026-01-01'), '2025-12-31');
  assert.equal(choreHistoryStart('1', '2024-03-01'), '2024-02-29');
  assert.equal(choreHistoryStart('5', '2026-03-30'), '2026-03-25');
  assert.equal(choreHistoryStart('10', '2026-10-26'), '2026-10-16');
  assert.equal(choreHistoryStart('forever', '2026-10-26'), null);
});

test('time filters hide older history, retain future/undated chores and preserve compact task actions', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const root = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = 'chore_history_' + process.pid;
  await root.query(`CREATE SCHEMA ${schema}`);
  const db = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  t.after(async () => { await db.end(); await root.query(`DROP SCHEMA ${schema} CASCADE`); await root.end(); });
  await db.query(fs.readFileSync('db/init.sql', 'utf8'));
  await migrate(db);
  const password = 'history-test-password';
  await db.query('UPDATE users SET password_hash=$1', [await bcrypt.hash(password, 4)]);
  const today = todayKey();
  const tasks = {};
  for (const offset of [0, -1, -5, -10, -11, 1]) {
    tasks[offset] = (await db.query(`INSERT INTO chores(title,description,user_id,points,due_date,is_quick)
      VALUES($1,'Full chore details',2,0,$2::date+$3::int,$4) RETURNING id`,
    ['History chore ' + offset, today, offset, offset === -5])).rows[0].id;
  }
  const undated = (await db.query("INSERT INTO chores(title,user_id,points) VALUES('No deadline',2,0) RETURNING id")).rows[0].id;
  const done = (await db.query("INSERT INTO chores(title,user_id,points,completed,completed_at) VALUES('Completed undated history',2,0,true,($1::date-5)::timestamp AT TIME ZONE 'Europe/Oslo') RETURNING id", [today])).rows[0].id;
  const server = createApp({ db, env: { SESSION_SECRET: 'history-tests', SESSION_COOKIE_SECURE: 'false' } }).listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  async function login(username) {
    const page = await fetch(base + '/login');
    const token = (await page.text()).match(/name="_csrf" value="([^"]+)"/)[1];
    const response = await fetch(base + '/login', { method: 'POST', redirect: 'manual',
      headers: { Cookie: page.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password, _csrf: token }) });
    assert.equal(response.status, 302);
    return response.headers.get('set-cookie').split(';')[0];
  }
  async function page(cookie, query = '') {
    const response = await fetch(base + '/dashboard?section=chores&' + query, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    return response.text();
  }
  const ids = html => [...html.matchAll(/<article[^>]+id="chore-(\d+)"/g)].map(m => Number(m[1])).sort((a,b) => a-b);
  const sorted = values => values.sort((a,b) => a-b);
  const admin = await login('admin'), member = await login('alex');
  for (const cookie of [admin, member]) {
    for (const [time, history] of [['today', []], ['1', [-1]], ['5', [-1,-5]], ['10', [-1,-5,-10]], ['forever', [-1,-5,-10,-11]]]) {
      const expected = sorted([tasks[0], tasks[1], undated, ...history.map(day => tasks[day]), ...(['5','10','forever'].includes(time) ? [done] : [])]);
      const html = await page(cookie, 'time=' + time);
      assert.deepEqual(ids(html), expected);
      assert.equal((html.match(/<details class="chore-disclosure">/g) || []).length, expected.length);
      assert.doesNotMatch(html, /<details class="chore-disclosure"[^>]*\bopen\b/);
      assert.match(html, /Full chore details/);
      if (cookie === member) assert.match(html, new RegExp('action="/chores/' + tasks[0] + '/toggle"'));
      else assert.match(html, new RegExp('action="/admin/chores/' + tasks[0] + '/status"'));
    }
    assert.deepEqual(ids(await page(cookie)), sorted([tasks[0], tasks[1], undated]));
    assert.deepEqual(ids(await page(cookie, 'time=bad')), sorted([tasks[0], tasks[1], undated]));
    assert.deepEqual(ids(await page(cookie, 'time=5&choreType=quick')), [tasks[-5]]);
    assert.deepEqual(ids(await page(cookie, 'time=5&status=completed')), [done]);
    assert.deepEqual(ids(await page(cookie, 'time=5&view=calendar&month=' + today.slice(0,7))),
      sorted([tasks[0], tasks[1], tasks[-1], tasks[-5], done].filter(id => {
        const offset = Object.entries(tasks).find(([,value]) => value === id)?.[0] ?? '-5';
        const date = new Date(today + 'T12:00:00Z'); date.setUTCDate(date.getUTCDate() + Number(offset));
        return date.toISOString().startsWith(today.slice(0,7));
      }).concat(undated)));
  }
  assert.deepEqual(ids(await page(admin, 'time=forever&member=3')), []);
  const returnTo = '/dashboard?section=chores&time=5&status=open&member=2';
  const html = await page(member, 'time=5');
  const token = html.match(/name="_csrf" value="([^"]+)"/)[1];
  const response = await fetch(base + '/chores/' + tasks[0] + '/toggle', { method: 'POST', redirect: 'manual',
    headers: { Cookie: member, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: token, completed: 'true', returnTo }) });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), returnTo + '#chore-' + tasks[0]);
});
