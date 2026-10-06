const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { Pool } = require("pg");
const webpush = require("web-push");
const { migrate } = require("../src/migrate");
const { createNotifications } = require("../src/notifications");
const { createApp } = require("../src/server");
const bcrypt = require("bcrypt");

test(
  "push preferences, routes, events, reminders and delivery against PostgreSQL",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const root = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = "notifications_test_" + process.pid;
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
    const keys = webpush.generateVAPIDKeys();
    const env = {
      VAPID_PUBLIC_KEY: keys.publicKey,
      VAPID_PRIVATE_KEY: keys.privateKey,
      VAPID_SUBJECT: "mailto:test@example.com",
      SESSION_COOKIE_SECURE: "false",
      SESSION_SECRET: "notification-tests",
    };
    const auth = Buffer.alloc(16).toString("base64url");
    for (const id of [1, 2, 3])
      await db.query(
        "INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth) VALUES($1,$2,$3,$4)",
        [id, "https://example.com/push/" + id, keys.publicKey, auth],
      );
    assert.deepEqual(
      (
        await db.query(
          "SELECT notify_due,notify_assignment,notify_requests FROM users WHERE id=2",
        )
      ).rows[0],
      { notify_due: true, notify_assignment: true, notify_requests: true },
    );
    const chore = (
      await db.query(
        "INSERT INTO chores(user_id,title,due_date) VALUES(2,'Laundry','2026-10-06') RETURNING id",
      )
    ).rows[0].id;
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int n FROM push_deliveries WHERE kind='assignment'",
        )
      ).rows[0].n,
      1,
    );
    await db.query("UPDATE chores SET user_id=2 WHERE id=$1", [chore]);
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int n FROM push_deliveries WHERE kind='assignment'",
        )
      ).rows[0].n,
      1,
    );
    await db.query("BEGIN");
    await db.query("INSERT INTO chores(user_id,title) VALUES(2,'Rollback')");
    await db.query("ROLLBACK");
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int n FROM push_deliveries WHERE kind='assignment'",
        )
      ).rows[0].n,
      1,
    );
    const request = (
      await db.query(
        "INSERT INTO chore_requests(user_id,recipient_id,chore_id,request_type,details) VALUES(2,3,$1,'other','Help') RETURNING id",
        [chore],
      )
    ).rows[0].id;
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int n FROM push_deliveries WHERE kind='requests'",
        )
      ).rows[0].n,
      2,
    );
    await db.query("UPDATE chore_requests SET status='approved' WHERE id=$1", [
      request,
    ]);
    await db.query("UPDATE chore_requests SET status='approved' WHERE id=$1", [
      request,
    ]);
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int n FROM push_deliveries WHERE kind='requests'",
        )
      ).rows[0].n,
      4,
    );
    await db.query("DELETE FROM push_deliveries");
    const sent = [];
    const notifications = createNotifications(db, env, async (...args) =>
      sent.push(args),
    );
    await notifications.maintain(new Date("2026-10-06T20:59:00Z"));
    assert.equal(sent.length, 0);
    await notifications.maintain(new Date("2026-10-06T21:00:00Z"));
    await notifications.maintain(new Date("2026-10-06T21:01:00Z"));
    assert.equal(sent.length, 1);
    assert.match(sent[0][1], /due in one hour/);
    await db.query(
      "INSERT INTO chores(user_id,title,due_date,completed) VALUES(2,'Done','2026-10-06',true),(2,'No deadline',NULL,false),(NULL,'No member','2026-10-06',false)",
    );
    await db.query("DELETE FROM push_deliveries");
    await notifications.maintain(new Date("2026-10-06T21:10:00Z"));
    assert.equal(sent.length, 1);
    // Pending reminders must be discarded after completion or a deadline change.
    for (const change of ["completed=true", "due_date='2026-10-07'"]) {
      await db.query(`SELECT queue_push(2,'due','A chore is due in one hour.','Laundry','/dashboard',
        '2026-10-06T22:00:00Z',$1,'2026-10-06')`, [chore]);
      await db.query('UPDATE push_deliveries SET next_attempt=$1', ['2026-10-06T21:00:00Z']);
      await db.query(`UPDATE chores SET ${change} WHERE id=$1`, [chore]);
      await notifications.maintain(new Date('2026-10-06T21:15:00Z'));
      assert.equal(sent.length,1);
      assert.equal((await db.query('SELECT * FROM push_deliveries')).rowCount,0);
      await db.query("UPDATE chores SET completed=false,due_date='2026-10-06' WHERE id=$1", [chore]);
    }
    // Oslo winter reminder at 22:00 UTC rather than summer's 21:00 UTC.
    await db.query(
      "INSERT INTO chores(user_id,title,due_date) VALUES(2,'Winter','2026-12-06')",
    );
    await db.query("DELETE FROM push_deliveries");
    await notifications.maintain(new Date("2026-12-06T21:59:00Z"));
    assert.equal(sent.length, 1);
    await notifications.maintain(new Date("2026-12-06T22:00:00Z"));
    assert.equal(sent.length, 2);
    await db.query(
      "SELECT queue_push(2,'assignment','A chore has been assigned to you.','','/dashboard')",
    );
    await db.query("UPDATE users SET notify_assignment=false WHERE id=2");
    await notifications.maintain();
    assert.equal(sent.length, 2);
    await db.query("UPDATE users SET notify_assignment=true WHERE id=2");
    await db.query(
      "SELECT queue_push(2,'assignment','A chore has been assigned to you.','','/dashboard')",
    );
    await createNotifications(db, env, async () => {
      throw Object.assign(new Error("expired"), { statusCode: 410 });
    }).maintain();
    assert.equal(
      (await db.query("SELECT * FROM push_subscriptions WHERE user_id=2"))
        .rowCount,
      0,
    );
    await db.query(
      "SELECT queue_push(3,'requests','A chore request needs approval.','','/dashboard')",
    );
    await createNotifications(db, env, async () => {
      throw Object.assign(new Error("temporary"), { statusCode: 503 });
    }).maintain();
    assert.equal(
      (await db.query("SELECT attempts FROM push_deliveries")).rows[0].attempts,
      1,
    );
    await db.query("UPDATE push_subscriptions SET user_id=2 WHERE user_id=3");
    assert.equal((await db.query("SELECT * FROM push_deliveries")).rowCount, 0);
    const password = "integration-password-only";
    await db.query("UPDATE users SET password_hash=$1", [
      await bcrypt.hash(password, 4),
    ]);
    const server = createApp({ db, env }).listen(0, "0.0.0.0");
    await new Promise((r) => server.once("listening", r));
    t.after(
      () =>
        new Promise((r) => {
          server.close(r);
          server.closeAllConnections();
        }),
    );
    const base = "http://127.0.0.1:" + server.address().port;
    const csrf = (html) => html.match(/name="_csrf" value="([^"]+)"/)[1];
    async function login(username) {
      let response = await fetch(base + "/login");
      let cookie = response.headers.get("set-cookie").split(";")[0];
      let token = csrf(await response.text());
      response = await fetch(base + "/login", {
        method: "POST",
        redirect: "manual",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ _csrf: token, username, password }),
      });
      cookie = response.headers.get("set-cookie").split(";")[0];
      response = await fetch(base + "/dashboard", {
        headers: { Cookie: cookie },
      });
      assert.equal(response.status, 200);
      token = csrf(await response.text());
      return { cookie, token };
    }
    async function post(path, body, user) {
      return fetch(base + path, {
        method: "POST",
        redirect: "manual",
        headers: {
          Cookie: user.cookie,
          "Content-Type": "application/json",
          "X-CSRF-Token": user.token,
        },
        body: JSON.stringify(body),
      });
    }
    const admin = await login("admin"),
      member = await login("alex"),
      recipient = await login("sam");
    assert.equal(
      (await post("/admin/users/2/notifications", {}, member)).status,
      403,
    );
    assert.equal(
      (
        await post(
          "/admin/users/2/notifications",
          { notify_due: "true" },
          admin,
        )
      ).status,
      302,
    );
    assert.equal(
      (await db.query("SELECT notify_requests FROM users WHERE id=2")).rows[0]
        .notify_requests,
      false,
    );
    assert.equal(
      (
        await post(
          "/api/push/subscribe",
          {
            endpoint: "https://127.0.0.1/push",
            keys: { p256dh: keys.publicKey, auth },
          },
          member,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await post(
          "/api/push/subscribe",
          {
            endpoint: "https://example.com/device",
            keys: { p256dh: keys.publicKey, auth },
          },
          member,
        )
      ).status,
      204,
    );
    assert.equal(
      (
        await post(
          "/api/push/unsubscribe",
          { endpoint: "https://example.com/device" },
          recipient,
        )
      ).status,
      204,
    );
    assert.equal(
      (
        await db.query(
          "SELECT * FROM push_subscriptions WHERE endpoint='https://example.com/device'",
        )
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await post(
          "/requests",
          {
            requestType: "other",
            details: "Recipient request",
            recipientId: "3",
          },
          member,
        )
      ).status,
      302,
    );
    const html = await (
      await fetch(base + "/dashboard?section=requests", {
        headers: { Cookie: recipient.cookie },
      })
    ).text();
    assert.match(html, /Recipient request/);
    const panel = await (
      await fetch(base + "/dashboard?section=administration", {
        headers: { Cookie: admin.cookie },
      })
    ).text();
    assert.match(panel, /Push notification settings/);
    assert.equal(
      (
        await post(
          "/api/push/unsubscribe",
          { endpoint: "https://example.com/device" },
          member,
        )
      ).status,
      204,
    );
    assert.equal(
      (
        await db.query(
          "SELECT * FROM push_subscriptions WHERE endpoint='https://example.com/device'",
        )
      ).rowCount,
      0,
    );
  },
);
