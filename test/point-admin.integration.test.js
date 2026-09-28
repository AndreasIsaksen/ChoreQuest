const { randomUUID } = require("node:crypto");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const { migrate } = require("../src/migrate");
const { createApp } = require("../src/server");
const { todayKey } = require("../src/helpers");

test(
  "administration points permissions, balances, audit filters and settlement",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const root = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = "point_admin_test_" + process.pid;
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
    const edit = (overrides = {}) => ({
      userId: 2,
      accountType: "weekly",
      operation: "add",
      amount: 30,
      reason: "Weekly reward",
      requestId: randomUUID(),
      ...overrides,
    });
    let r = await fetch(base + "/dashboard?section=administration", {
      headers: { Cookie: alex.cookie },
    });
    assert.equal(r.status, 403);
    assert.equal(await post("/admin/points", edit(), alex), 403);
    assert.equal(
      await post("/admin/points", edit({ _csrf: "wrong" }), admin),
      403,
    );
    for (const invalid of [
      { amount: 0 },
      { amount: -1 },
      { amount: "1.5" },
      { amount: 1000001 },
      { reason: " " },
      { accountType: "other" },
      { operation: "set" },
      { userId: 999999 },
      { requestId: "invalid" },
    ])
      assert.equal(await post("/admin/points", edit(invalid), admin), 400);
    assert.deepEqual(await balances(2), {
      weekly_points: "0",
      permanent_points: "0",
    });
    const first = edit();
    assert.equal(await post("/admin/points", first, admin), 302);
    assert.equal(await post("/admin/points", first, admin), 302);
    assert.equal(
      await post("/admin/points", { ...first, amount: 31 }, admin),
      409,
    );
    assert.equal(
      (
        await db.query(
          "SELECT * FROM point_ledger WHERE kind='admin_adjustment'",
        )
      ).rowCount,
      1,
    );
    assert.equal(
      await post(
        "/admin/points",
        edit({
          operation: "withdraw",
          amount: 40,
          reason: "Weekly correction",
        }),
        admin,
      ),
      302,
    );
    assert.equal(
      await post(
        "/admin/points",
        edit({
          accountType: "permanent",
          amount: 100,
          reason: "Permanent reward",
        }),
        admin,
      ),
      302,
    );
    assert.equal(
      await post(
        "/admin/points",
        edit({
          accountType: "permanent",
          operation: "withdraw",
          amount: 15,
          reason: "Permanent correction",
        }),
        admin,
      ),
      302,
    );
    assert.deepEqual(await balances(2), {
      weekly_points: "-10",
      permanent_points: "85",
    });
    const audit = (
      await db.query(
        "SELECT amount,account_type,reason,balance_before::text,balance_after::text,actor_id FROM point_ledger WHERE kind='admin_adjustment' ORDER BY id",
      )
    ).rows;
    assert.deepEqual(
      audit.map((a) => [
        a.amount,
        a.account_type,
        a.balance_before,
        a.balance_after,
        a.actor_id,
      ]),
      [
        [30, "weekly", "0", "30", 1],
        [-40, "weekly", "30", "-10", 1],
        [100, "permanent", "0", "100", 1],
        [-15, "permanent", "100", "85", 1],
      ],
    );
    await Promise.all([
      post("/admin/points", edit({ amount: 5 }), admin),
      post("/admin/points", edit({ amount: 5 }), admin),
    ]);
    assert.deepEqual(await balances(2), {
      weekly_points: "0",
      permanent_points: "85",
    });
    assert.equal(
      await post(
        "/admin/points",
        edit({
          userId: 3,
          reason: "Sam-only correction <script>alert(1)</script>",
        }),
        admin,
      ),
      302,
    );
    let html = await (
      await fetch(base + "/dashboard?section=administration", {
        headers: { Cookie: admin.cookie },
      })
    ).text();
    assert.match(html, /Chore library/);
    assert.match(html, /Save point adjustment/);
    assert.match(html, /Permanent correction/);
    assert.match(html, /Sam-only correction &lt;script&gt;/);
    assert.doesNotMatch(html, /<script>alert/);
    const requestToken = html.match(/name="requestId" value="([^"]+)"/)[1];
    assert.match(requestToken, /^[0-9a-f-]{36}$/);
    html = await (
      await fetch(base + "/dashboard?section=administration&historyMember=2", {
        headers: { Cookie: admin.cookie },
      })
    ).text();
    assert.match(html, /Permanent correction/);
    assert.doesNotMatch(html, /Sam-only correction/);
    for (let i = 0; i < 45; i++)
      assert.equal(
        await post(
          "/admin/points",
          edit({ amount: 1, reason: "Pagination " + i }),
          admin,
        ),
        302,
      );
    html = await (
      await fetch(base + "/dashboard?section=administration&historyMember=2", {
        headers: { Cookie: admin.cookie },
      })
    ).text();
    assert.match(html, /Older edits/);
    assert.doesNotMatch(html, /0 → 30/);
    html = await (
      await fetch(
        base +
          "/dashboard?section=administration&historyMember=2&historyPage=2",
        { headers: { Cookie: admin.cookie } },
      )
    ).text();
    assert.match(html, /0 → 30/);
    assert.match(html, /Newer edits/);
    // Deleting an administrator anonymises their audit identity while keeping other members' balance records.
    await db.query("UPDATE users SET role='admin' WHERE id=3");
    assert.equal(
      await post(
        "/admin/users/1",
        { action: "remove", confirmUsername: "admin" },
        sam,
      ),
      302,
    );
    assert.equal(
      (
        await db.query(
          "SELECT * FROM point_ledger WHERE user_id=2 AND actor_id IS NOT NULL",
        )
      ).rowCount,
      0,
    );
    assert.deepEqual(await balances(2), {
      weekly_points: "45",
      permanent_points: "85",
    });
    html = await (
      await fetch(base + "/dashboard?section=administration", {
        headers: { Cookie: sam.cookie },
      })
    ).text();
    assert.match(html, /Deleted administrator/);
    await db.query("SELECT process_points($1::date+7)", [todayKey()]);
    assert.deepEqual(await balances(2), {
      weekly_points: "0",
      permanent_points: "130",
    });
    assert.equal(
      await post(
        "/admin/users/2",
        { action: "remove", confirmUsername: "alex" },
        sam,
      ),
      302,
    );
    assert.equal(
      (await db.query("SELECT * FROM point_ledger WHERE user_id=2")).rowCount,
      0,
    );
    assert.equal(
      (await db.query("SELECT * FROM point_accounts WHERE user_id=2")).rowCount,
      0,
    );
  },
);
