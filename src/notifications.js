const webpush = require("web-push");
const { lookup } = require("node:dns").promises;
const net = require("node:net");
const dns = require("node:dns");
const https = require("node:https");
// Validate the address used by the socket too, preventing DNS rebinding.
const pushAgent = new https.Agent({
  lookup(hostname, options, callback) {
    dns.lookup(hostname, options, (error, address, family) => {
      if (error) return callback(error);
      const addresses = Array.isArray(address)
        ? address.map((entry) => entry.address)
        : [address];
      if (addresses.some((value) => !publicAddress(value)))
        return callback(new Error("Push endpoint must use a public address"));
      callback(null, address, family);
    });
  },
});
const { translator } = require("./i18n");
const { problem } = require("./admin");

// Subscription endpoints cause outbound requests; accept public HTTPS push services only.
function publicAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  // Reject local, mapped IPv4 and other reserved IPv6 ranges.
  return net.isIP(address) === 6 && /^2[0-9a-f]{3}:/i.test(address);
}
async function validateEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    problem("Invalid push subscription.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443") ||
    endpoint.length > 2048
  )
    problem("Invalid push subscription.");
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ""), {
    all: true,
  });
  if (
    !addresses.length ||
    addresses.some(({ address }) => !publicAddress(address))
  )
    problem("Invalid push subscription.");
}
function createNotifications(
  db,
  env = process.env,
  send = webpush.sendNotification,
) {
  const configured = !!(
    env.VAPID_PUBLIC_KEY &&
    env.VAPID_PRIVATE_KEY &&
    env.VAPID_SUBJECT
  );
  const vapidDetails = configured
    ? {
        subject: env.VAPID_SUBJECT,
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY,
      }
    : null;
  if (configured)
    webpush.generateRequestDetails(
      {
        endpoint: "https://example.com",
        keys: {
          p256dh: env.VAPID_PUBLIC_KEY,
          auth: Buffer.alloc(16).toString("base64url"),
        },
      },
      null,
      { vapidDetails },
    );
  async function maintain(now = new Date()) {
    if (!configured) return;
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      // One worker at a time, including delivery, without overlapping interval runs.
      if (
        !(await c.query("SELECT pg_try_advisory_xact_lock(718432) AS locked"))
          .rows[0].locked
      ) {
        await c.query("ROLLBACK");
        return;
      }
      const reminders = (
        await c.query(
          `INSERT INTO push_reminders(chore_id,user_id,due_date)
        SELECT ch.id,m.user_id,ch.due_date FROM chores ch JOIN chore_members m ON m.chore_id=ch.id
        JOIN users u ON u.id=m.user_id WHERE NOT ch.completed AND ch.removed_at IS NULL AND u.deleted_at IS NULL AND u.notify_due
        AND (ch.window_start IS NULL OR ch.window_start <= ($1::timestamptz AT TIME ZONE 'Europe/Oslo')::date)
        AND $1::timestamptz >= chore_deadline(ch.due_date,ch.due_time)-interval '1 hour'
        AND $1::timestamptz < chore_deadline(ch.due_date,ch.due_time)
        AND EXISTS(SELECT 1 FROM push_subscriptions s WHERE s.user_id=m.user_id)
        ON CONFLICT DO NOTHING RETURNING *`,
          [now],
        )
      ).rows;
      for (const r of reminders) {
        await c.query(
          `SELECT queue_push($1,'due','A chore is due in one hour.',
        (SELECT title FROM chores WHERE id=$2),'/dashboard?section=chores',(SELECT chore_deadline(due_date,due_time) FROM chores WHERE id=$2),$2,$3::date)`,
          [r.user_id, r.chore_id, r.due_date],
        );
        // Reminders created in this pass are eligible using the worker's clock.
        await c.query("UPDATE push_deliveries SET next_attempt=$1 WHERE reminder_chore_id=$2 AND reminder_due_date=$3 AND attempts=0", [now, r.chore_id, r.due_date]);
      }
      await c.query("DELETE FROM push_deliveries WHERE expires_at <= $1", [
        now,
      ]);
      const deliveries = (
        await c.query(
          `SELECT d.*,s.endpoint,s.p256dh,s.auth,s.language FROM push_deliveries d
        JOIN push_subscriptions s ON s.id=d.subscription_id JOIN users u ON u.id=s.user_id
        WHERE next_attempt <= $1 AND u.deleted_at IS NULL ORDER BY d.id LIMIT 50`,
          [now],
        )
      ).rows;
      for (const d of deliveries) {
        const allowed = (
          await c.query(
            `SELECT CASE $2 WHEN 'due' THEN notify_due WHEN 'assignment' THEN notify_assignment ELSE notify_requests END AS allowed
          FROM users u JOIN push_subscriptions s ON s.user_id=u.id WHERE s.id=$1`,
            [d.subscription_id, d.kind],
          )
        ).rows[0]?.allowed;
        try {
          const validReminder =
            d.kind !== "due" ||
            (
              await c.query(
                `SELECT 1 FROM chores ch JOIN chore_members m ON m.chore_id=ch.id
            JOIN push_subscriptions s ON s.user_id=m.user_id WHERE ch.id=$1 AND s.id=$2
            AND NOT ch.completed AND ch.removed_at IS NULL AND ch.due_date=$3`,
                [d.reminder_chore_id, d.subscription_id, d.reminder_due_date],
              )
            ).rowCount > 0;
          if (allowed && validReminder) {
            await validateEndpoint(d.endpoint);
            const t = translator(d.language);
            await send(
              {
                endpoint: d.endpoint,
                keys: { p256dh: d.p256dh, auth: d.auth },
              },
              JSON.stringify({
                title: "ChoreQuest",
                body: t(d.message) + (d.title ? " " + d.title : ""),
                url: d.url,
                tag: "chorequest-" + d.id,
              }),
              {
                vapidDetails,
                agent: pushAgent,
                timeout: 10000,
                TTL: Math.max(
                  1,
                  Math.min(
                    86400,
                    Math.floor((new Date(d.expires_at) - now) / 1000),
                  ),
                ),
              },
            );
          }
          await c.query("DELETE FROM push_deliveries WHERE id=$1", [d.id]);
        } catch (error) {
          if ([404, 410].includes(error.statusCode))
            await c.query("DELETE FROM push_subscriptions WHERE id=$1", [
              d.subscription_id,
            ]);
          else if (error.status === 400 || d.attempts >= 4)
            await c.query("DELETE FROM push_deliveries WHERE id=$1", [d.id]);
          else
            await c.query(
              "UPDATE push_deliveries SET attempts=attempts+1,next_attempt=$2::timestamptz+interval '5 minutes' WHERE id=$1",
              [d.id, now],
            );
        }
      }
      await c.query("COMMIT");
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    } finally {
      c.release();
    }
  }
  return {
    configured,
    publicKey: configured ? env.VAPID_PUBLIC_KEY : null,
    maintain,
  };
}
function installNotifications(
  app,
  db,
  requireAuth,
  requireAdmin,
  notifications,
) {
  app.get("/api/push", requireAuth, (req, res) =>
    res.json({ publicKey: notifications.publicKey }),
  );
  app.post("/api/push/subscribe", requireAuth, async (req, res) => {
    if (!notifications.configured)
      problem("Push notifications are not configured.", 503);
    const { endpoint, keys } = req.body;
    if (
      typeof endpoint !== "string" ||
      typeof keys?.p256dh !== "string" ||
      typeof keys?.auth !== "string" ||
      !/^[\w-]+={0,2}$/.test(keys.p256dh) ||
      !/^[\w-]+={0,2}$/.test(keys.auth) ||
      Buffer.from(keys.p256dh, "base64url").length !== 65 ||
      Buffer.from(keys.auth, "base64url").length !== 16
    )
      problem("Invalid push subscription.");
    await validateEndpoint(endpoint);
    // A browser subscription belongs to the most recently signed-in account on that device.
    await db.query(
      `INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth,language) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(endpoint) DO UPDATE SET user_id=EXCLUDED.user_id,p256dh=EXCLUDED.p256dh,auth=EXCLUDED.auth,language=EXCLUDED.language`,
      [
        req.session.user.id,
        endpoint,
        keys.p256dh,
        keys.auth,
        res.locals.language,
      ],
    );
    res.sendStatus(204);
  });
  app.post("/api/push/unsubscribe", requireAuth, async (req, res) => {
    await db.query(
      "DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2",
      [req.session.user.id, req.body.endpoint],
    );
    res.sendStatus(204);
  });
  app.post("/admin/users/:id/notifications", requireAdmin, async (req, res) => {
    const values = ["notify_due", "notify_assignment", "notify_requests"].map(
      (key) => {
        if (req.body[key] !== undefined && req.body[key] !== "true")
          problem("Invalid notification settings.");
        return req.body[key] === "true";
      },
    );
    if (!/^\d+$/.test(req.params.id) || Number(req.params.id) > 2147483647)
      problem("Account not found.", 404);
    const result = await db.query(
      "UPDATE users SET notify_due=$2,notify_assignment=$3,notify_requests=$4 WHERE id=$1 AND deleted_at IS NULL RETURNING id",
      [req.params.id, ...values],
    );
    if (!result.rowCount) problem("Account not found.", 404);
    req.session.flash = "Notification settings saved.";
    res.redirect("/dashboard?section=administration#point-accounts");
  });
}
module.exports = {
  createNotifications,
  installNotifications,
  publicAddress,
  validateEndpoint,
};
