const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const { migrate } = require("../src/migrate");
const { createApp } = require("../src/server");
const { todayKey } = require("../src/helpers");

test(
  "admin chore status permissions and point corrections",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const root = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = "chore_status_test_" + process.pid;
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
    const balances = async (id) =>
      (
        await db.query(
          "SELECT weekly_points::text,permanent_points::text FROM member_points WHERE user_id=$1",
          [id],
        )
      ).rows[0];
    const chore = async (due, cooperative = false, points = 10) => {
      const id = (await db.query("INSERT INTO chores(title,user_id,points,due_date,cooperative) VALUES('Status test',$1,$2,$3,$4) RETURNING id", [cooperative ? null : 2, points, due, cooperative])).rows[0].id;
      if (cooperative) await db.query('INSERT INTO chore_participants VALUES($1,2),($1,3)', [id]);
      return id;
    };
    const set = (id, completed, auth = admin) => post(`/admin/chores/${id}/status`, {completed}, auth);
    const clear = async () => { await db.query('TRUNCATE point_ledger,point_accounts'); await db.query('DELETE FROM chore_participants'); await db.query('DELETE FROM chores'); };
    // Reopening a previously completed chore after its deadline deducts immediately.
    const pastDone = await chore(null);
    await db.query('UPDATE chores SET completed=true WHERE id=$1', [pastDone]);
    await db.query("UPDATE chores SET due_date='2020-01-05' WHERE id=$1", [pastDone]);
    await set(pastDone, 'false');
    assert.deepEqual(await balances(2), {weekly_points:'0', permanent_points:'-10'});
    await clear();

    const memberLate = await chore('2020-01-05');
    await post(`/chores/${memberLate}/toggle`, {completed:'true'}, alex);
    assert.deepEqual(await balances(2), {weekly_points:'10', permanent_points:'-10'});
    await set(memberLate, 'true');
    assert.deepEqual(await balances(2), {weekly_points:'20', permanent_points:'-10'});
    await clear();

    const old = await chore('2020-01-05');
    assert.equal(await set(old, 'true', alex), 403);
    assert.equal(await post(`/admin/chores/${old}/status`, {completed:'true', _csrf:'wrong'}, admin), 403);
    assert.equal(await set(old, 'invalid'), 400);
    assert.equal(await set(999999, 'true'), 404);
    assert.equal(await set(old, 'true'), 302);
    assert.deepEqual(await balances(2), {weekly_points:'20', permanent_points:'-10'});
    await Promise.all([set(old, 'true'), set(old, 'true')]);
    assert.deepEqual(await balances(2), {weekly_points:'20', permanent_points:'-10'});
    assert.equal(await set(old, 'false'), 302);
    assert.deepEqual(await balances(2), {weekly_points:'0', permanent_points:'-10'});
    await set(old, 'true');
    // Member reopening also reverses administrator compensation.
    assert.equal(await post(`/chores/${old}/toggle`, {completed:'false'}, alex), 302);
    assert.deepEqual(await balances(2), {weekly_points:'0', permanent_points:'-10'});
    await clear();

    const today = todayKey();
    const recent = await chore(today);
    await db.query("SELECT post_points(2,$1,'overdue',-10,$2::date,$2::date)", [recent,today]);
    await set(recent, 'true');
    assert.deepEqual(await balances(2), {weekly_points:'10', permanent_points:'0'});
    await set(recent, 'false');
    assert.deepEqual(await balances(2), {weekly_points:'-10', permanent_points:'0'});
    await clear();

    const shared = await chore('2020-01-05', true);
    await set(shared, 'true');
    for (const user of [2,3]) assert.deepEqual(await balances(user), {weekly_points:'20', permanent_points:'-10'});
    await set(shared, 'false');
    for (const user of [2,3]) assert.deepEqual(await balances(user), {weekly_points:'0', permanent_points:'-10'});
    await clear();

    const timely = await chore(null);
    await set(timely, 'true');
    assert.deepEqual(await balances(2), {weekly_points:'10', permanent_points:'0'});
    await set(timely, 'false');
    assert.deepEqual(await balances(2), {weekly_points:'0', permanent_points:'0'});
    await db.query('UPDATE chores SET window_start=$1::date+7 WHERE id=$2', [today,timely]);
    await set(timely, 'true');
    assert.equal((await balances(2)).weekly_points,'10');
    let html = await (await fetch(base+'/dashboard', {headers:{Cookie:admin.cookie}})).text();
    assert.match(html, /Change chore status/);
    html = await (await fetch(base+'/dashboard', {headers:{Cookie:alex.cookie}})).text();
    assert.doesNotMatch(html, /Change chore status/);
    await db.query('UPDATE chores SET removed_at=now() WHERE id=$1', [timely]);
    assert.equal(await set(timely, 'false'),404);
    await clear();
    const unassigned = (await db.query("INSERT INTO chores(title) VALUES('Unassigned') RETURNING id")).rows[0].id;
    assert.equal(await set(unassigned, 'true'),409);
    const zero = await chore('2020-01-05', false, 0);
    await set(zero, 'true');
    assert.deepEqual(await balances(2), {weekly_points:'0', permanent_points:'0'});
  },
);
