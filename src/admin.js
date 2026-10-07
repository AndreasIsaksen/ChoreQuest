const bcrypt = require("bcrypt");
const { todayKey } = require("./helpers");
function problem(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  throw e;
}
function text(value, label, max = 160) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    problem(`${label} is required (maximum ${max} characters).`);
  return value.trim();
}
function points(value) {
  if (value === undefined) return 0;
  if (
    !/^\d+$/.test(String(value)) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) > 1000000
  )
    problem("Points must be a whole number between 0 and 1,000,000.");
  return Number(value);
}
function date(value, required = false) {
  if (!value && !required) return null;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value < "2000-01-01" ||
    value > "2100-12-31" ||
    isNaN(Date.parse(value + "T12:00:00Z")) ||
    new Date(value + "T12:00:00Z").toISOString().slice(0, 10) !== value
  )
    problem("Enter a valid date between 2000 and 2100.");
  return value;
}
function id(value) {
  if (
    !/^\d+$/.test(String(value)) ||
    Number(value) < 1 ||
    !Number.isSafeInteger(Number(value))
  )
    problem("Invalid account or chore.");
  return Number(value);
}
async function assignee(db, value) {
  if (!value) return null;
  const key = id(value);
  if (
    !(
      await db.query(
        "SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL",
        [key],
      )
    ).rowCount
  )
    problem("Choose an active account.");
  return key;
}
async function participants(db, body) {
  const raw = body.memberIds ?? body.userId;
  const values = [
    ...new Set((Array.isArray(raw) ? raw : [raw]).filter(Boolean)),
  ];
  if (values.length > 100) problem("Choose at most 100 members.");
  const result = [];
  for (const value of values) result.push(await assignee(db, value));
  return result;
}
async function assignChore(c, template, b) {
  const members = await participants(c, b);
  const mode = b.mode || "individual";
  if (!["individual", "cooperative"].includes(mode))
    problem("Choose an assignment type.");
  const cooperative = mode === "cooperative";
  if (cooperative && members.length < 2)
    problem("Select at least two members for a co-op chore.");
  const recurring = ["recurring", "weekdays"].includes(b.schedule);
  const starts = date(b.startsOn, recurring);
  const due = date(b.dueDate);
  const dueTime = b.dueTime || null;
  if (dueTime && (typeof dueTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(dueTime)))
    problem("Enter a valid due time (HH:MM).");
  if (dueTime && !recurring && !due) problem("Choose a due date when setting a due time.");
  let weekdays = null;
  if (b.schedule === "weekdays") {
    const raw = Array.isArray(b.weekdays) ? b.weekdays : [b.weekdays];
    if (!raw.length || raw.some(value => !/^[1-7]$/.test(String(value))))
      problem("Choose at least one valid weekday.");
    weekdays = [...new Set(raw.map(Number))].sort();
  }
  if (b.schedule && !["once", "recurring", "weekdays"].includes(b.schedule))
    problem("Invalid schedule.");
  const count = weekdays ? 1 : Number(b.intervalCount);
  const unit = weekdays ? "weeks" : b.intervalUnit;
  if (recurring) {
    if (
      !Number.isInteger(count) ||
      count < 1 ||
      count > 365 ||
      !["days", "weeks", "months"].includes(unit)
    )
      problem("Choose a recurrence of 1–365 days, weeks, or months.");
    if (starts < todayKey())
      problem("Start a new recurring chore today or later.");
  } else if (starts && due && due < starts)
    problem("The due date must be on or after the start date.");
  for (const member of cooperative
    ? [null]
    : members.length
      ? members
      : [null]) {
    const row = recurring
      ? await c.query(
          "INSERT INTO chore_series(title,description,user_id,starts_on,interval_count,interval_unit,template_id,cooperative,points,weekdays,due_time) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id",
          [
            template.title,
            template.description,
            member,
            starts,
            count,
            unit,
            template.id,
            cooperative,
            template.points,
            weekdays,
            dueTime,
          ],
        )
      : await c.query(
          "INSERT INTO chores(title,description,user_id,window_start,due_date,template_id,cooperative,points,due_time) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
          [
            template.title,
            template.description,
            member,
            starts,
            due,
            template.id,
            cooperative,
            template.points,
            dueTime,
          ],
        );
    if (cooperative) {
      for (const person of members) {
        await c.query(
          recurring
            ? "INSERT INTO series_participants(series_id,user_id) VALUES($1,$2)"
            : "INSERT INTO chore_participants(chore_id,user_id) VALUES($1,$2)",
          [row.rows[0].id, person],
        );
      }
    }
  }
  if (recurring)
    await c.query("SELECT generate_chore_occurrences($1::date)", [todayKey()]);
}
async function transaction(db, fn) {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    // Serialize changes with recurring generation and settle debts before changing ownership.
    await c.query("SELECT pg_advisory_xact_lock(718431)");
    await c.query("SELECT process_points($1::date)", [todayKey()]);
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
async function passwordHash(value) {
  if (
    typeof value !== "string" ||
    value.length < 12 ||
    Buffer.byteLength(value) > 72
  )
    problem("Use a password of at least 12 characters and at most 72 bytes.");
  return bcrypt.hash(value, 12);
}
function installAdmin(app, db, requireAdmin) {
  const redirect = (req, res, message, section = "administration") => {
    req.session.flash = message;
    res.redirect("/dashboard?section=" + section);
  };
  app.post("/admin/chores/:id/status", requireAdmin, async (req, res) => {
    if (!["true", "false"].includes(req.body.completed))
      problem("Invalid completion state.");
    const choreId = id(req.params.id);
    await transaction(db, async (c) => {
      const chore = (await c.query(
        "SELECT * FROM chores WHERE id=$1 AND removed_at IS NULL FOR UPDATE",
        [choreId],
      )).rows[0];
      if (!chore) problem("Chore not found.", 404);
      if (!(await c.query("SELECT 1 FROM chore_members WHERE chore_id=$1", [choreId])).rowCount)
        problem("Choose an assigned chore.", 409);
      await c.query("SELECT set_admin_chore_status($1,$2,$3,$4::date)", [
        choreId, req.body.completed === "true", req.session.user.id, todayKey(),
      ]);
    });
    redirect(req, res, "Chore status and points updated.", "chores");
  });
  app.post("/admin/points", requireAdmin, async (req, res) => {
    const b = req.body;
    if (
      !["weekly", "permanent"].includes(b.accountType) ||
      !["add", "withdraw"].includes(b.operation)
    )
      problem("Choose an account and adjustment action.");
    const amount = points(b.amount);
    if (!amount) problem("Enter at least one point.");
    const reason = text(b.reason, "Reason", 500);
    if (
      typeof b.requestId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        b.requestId,
      )
    )
      problem("Reload the administration page before adjusting points.");
    await transaction(db, async (c) => {
      await c.query("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE");
      const target = await assignee(c, b.userId);
      if (!target) problem("Choose an active account.");
      const delta = b.operation === "add" ? amount : -amount;
      const previous = (
        await c.query("SELECT * FROM point_ledger WHERE request_id=$1", [
          b.requestId,
        ])
      ).rows[0];
      if (previous) {
        if (
          previous.user_id !== target ||
          previous.actor_id !== req.session.user.id ||
          previous.amount !== delta ||
          previous.account_type !== b.accountType ||
          previous.reason !== reason
        )
          problem(
            "This adjustment was already submitted with different details. Reload the page.",
            409,
          );
        return;
      }
      const balances = (
        await c.query("SELECT * FROM member_points WHERE user_id=$1", [target])
      ).rows[0];
      const before = BigInt(
        b.accountType === "weekly"
          ? balances.weekly_points
          : balances.permanent_points,
      );
      const after = before + BigInt(delta);
      // Permanent adjustments use the previous settled week, keeping this week's bucket separate.
      const week = (
        await c.query(
          "SELECT (date_trunc('week',$1::date)::date - CASE WHEN $2='permanent' THEN 7 ELSE 0 END)::text AS week",
          [todayKey(), b.accountType],
        )
      ).rows[0].week;
      await c.query(
        "INSERT INTO point_ledger(user_id,kind,amount,week_start,actor_id,account_type,reason,balance_before,balance_after,request_id) VALUES($1,'admin_adjustment',$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          target,
          delta,
          week,
          req.session.user.id,
          b.accountType,
          reason,
          before.toString(),
          after.toString(),
          b.requestId,
        ],
      );
      await c.query(
        "INSERT INTO point_accounts(user_id,week_start,balance,settled) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,week_start) DO UPDATE SET balance=point_accounts.balance+EXCLUDED.balance,settled=point_accounts.settled OR EXCLUDED.settled",
        [target, week, delta, b.accountType === "permanent"],
      );
    });
    redirect(req, res, "Points adjusted and recorded in history.");
  });
  // Removal keeps occurrence rows so cancelled recurring windows are never regenerated.
  for (const [route, table, scope] of [
    ["library", "chore_templates", "template_id"],
    ["series", "chore_series", "series_id"],
    ["chores", "chores", "id"],
  ]) {
    app.post(`/admin/${route}/:id/delete`, requireAdmin, async (req, res) => {
      await transaction(db, async (c) => {
        const target = id(req.params.id);
        const item = (
          await c.query(
            `SELECT * FROM ${table} WHERE id=$1 AND removed_at IS NULL FOR UPDATE`,
            [target],
          )
        ).rows[0];
        if (!item) problem("Chore not found.", 404);
        if (req.body.confirmTitle !== item.title)
          problem("Type the chore name to confirm deletion.");
        await c.query("SELECT generate_chore_occurrences($1::date)", [
          todayKey(),
        ]);
        await c.query("SELECT process_points($1::date)", [todayKey()]);
        if (route === "library") {
          await c.query(
            "UPDATE chore_templates SET removed_at=now() WHERE id=$1",
            [target],
          );
          await c.query(
            "UPDATE chore_series SET active=false,removed_at=now() WHERE template_id=$1 AND removed_at IS NULL",
            [target],
          );
        } else if (route === "series") {
          await c.query(
            "UPDATE chore_series SET active=false,removed_at=now() WHERE id=$1",
            [target],
          );
        }
        await c.query(
          `UPDATE chores SET removed_at=now(),removed_history=(completed OR COALESCE(chore_deadline(due_date,due_time)<=chore_as_of($2::date),false)) WHERE ${scope}=$1 AND removed_at IS NULL`,
          [target, todayKey()],
        );
        await c.query(
          `UPDATE chore_requests SET status='rejected',admin_note='Chore removed.' WHERE status='pending' AND chore_id IN (SELECT id FROM chores WHERE ${scope}=$1 AND removed_at IS NOT NULL)`,
          [target],
        );
      });
      redirect(
        req,
        res,
        "Chore removed. Completed and overdue history and points have been preserved.",
      );
    });
  }
  app.post("/admin/chores", requireAdmin, async (req, res) => {
    const b = req.body;
    const title = text(b.title, "Title");
    const description =
      typeof b.description === "string" ? b.description.trim() : "";
    if (description.length > 2000) problem("Description is too long.");
    await transaction(db, async (c) => {
      await c.query("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE");
      const template = (
        await c.query(
          "INSERT INTO chore_templates(title,description,points) VALUES($1,$2,$3) RETURNING *",
          [title, description, points(b.points)],
        )
      ).rows[0];
      // Retain the previous API for existing clients; the creation form now saves only a definition.
      if (b.schedule) await assignChore(c, template, b);
    });
    redirect(
      req,
      res,
      "Chore saved in the library. Use Administer chore to assign and schedule it.",
    );
  });
  app.post("/admin/library/:id/assign", requireAdmin, async (req, res) => {
    await transaction(db, async (c) => {
      await c.query("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE");
      const template = (
        await c.query(
          "SELECT * FROM chore_templates WHERE id=$1 AND removed_at IS NULL FOR UPDATE",
          [id(req.params.id)],
        )
      ).rows[0];
      if (!template) problem("Chore not found.", 404);
      if (req.body.points !== undefined) {
        template.points = points(req.body.points);
        await c.query("UPDATE chore_templates SET points=$1 WHERE id=$2", [
          template.points,
          template.id,
        ]);
      }
      await assignChore(c, template, req.body);
    });
    redirect(
      req,
      res,
      "Chore added to the household plan. The definition stays in your library.",
      "chores",
    );
  });
  app.post("/admin/library/:id", requireAdmin, async (req, res) => {
    const title = text(req.body.title, "Title");
    const description =
      typeof req.body.description === "string"
        ? req.body.description.trim()
        : "";
    if (description.length > 2000) problem("Description is too long.");
    const r = await db.query(
      "UPDATE chore_templates SET title=$1,description=$2,points=$4 WHERE id=$3 AND removed_at IS NULL RETURNING id",
      [title, description, id(req.params.id), points(req.body.points)],
    );
    if (!r.rowCount) problem("Chore not found.", 404);
    redirect(
      req,
      res,
      "Library chore updated. Existing tasks and schedules keep their original details.",
    );
  });
  app.post("/admin/chores/:id/assign", requireAdmin, async (req, res) => {
    await transaction(db, async (c) => {
      await c.query("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE");
      const chore = (
        await c.query("SELECT * FROM chores WHERE id=$1 FOR UPDATE", [
          id(req.params.id),
        ])
      ).rows[0];
      if (!chore || chore.completed || chore.removed_at)
        problem("Chore not found or already completed.", 409);
      const members = await participants(c, req.body);
      if (!chore.cooperative && members.length > 1)
        problem(
          "An individual task has one assignee. Create separate tasks from the library.",
        );
      const userId = chore.cooperative ? null : members[0] || null;
      const result = await c.query(
        "UPDATE chores SET user_id=$1 WHERE id=$2 AND completed=false RETURNING id",
        [userId, id(req.params.id)],
      );
      if (!result.rowCount)
        problem("Chore not found or already completed.", 409);
      await c.query("DELETE FROM chore_participants WHERE chore_id=$1", [
        chore.id,
      ]);
      if (chore.cooperative)
        for (const person of members)
          await c.query(
            "INSERT INTO chore_participants(chore_id,user_id) VALUES($1,$2)",
            [chore.id, person],
          );
    });
    redirect(req, res, "Assignment updated for this chore.");
  });
  app.post("/admin/series/:id", requireAdmin, async (req, res) => {
    await transaction(db, async (c) => {
      await c.query("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE");
      const schedule = (
        await c.query("SELECT * FROM chore_series WHERE id=$1 FOR UPDATE", [
          id(req.params.id),
        ])
      ).rows[0];
      if (!schedule || schedule.removed_at) problem("Schedule not found.", 404);
      const members = await participants(c, req.body);
      if (!schedule.cooperative && members.length > 1)
        problem("Choose one member for an individual schedule.");
      const userId = schedule.cooperative ? null : members[0] || null;
      if (!["true", "false"].includes(req.body.active))
        problem("Invalid schedule state.");
      const r = await c.query(
        "UPDATE chore_series SET user_id=$1, active=$2 WHERE id=$3 RETURNING id",
        [userId, req.body.active === "true", id(req.params.id)],
      );
      if (!r.rowCount) problem("Schedule not found.", 404);
      await c.query("DELETE FROM series_participants WHERE series_id=$1", [
        schedule.id,
      ]);
      if (schedule.cooperative)
        for (const person of members)
          await c.query(
            "INSERT INTO series_participants(series_id,user_id) VALUES($1,$2)",
            [schedule.id, person],
          );
    });
    redirect(
      req,
      res,
      "Schedule updated. Existing periods are unchanged; resuming fills missed periods.",
    );
  });
  app.post("/admin/users", requireAdmin, async (req, res) => {
    const username = text(req.body.username, "Username", 40).toLowerCase();
    if (!/^[a-z0-9_.-]+$/.test(username))
      problem(
        "Username may contain letters, numbers, dots, hyphens and underscores.",
      );
    const display = text(req.body.displayName, "Display name", 80);
    const hash = await passwordHash(req.body.password);
    if (!["admin", "member"].includes(req.body.role))
      problem("Choose a valid role.");
    await db.query(
      "INSERT INTO users(username,display_name,role,password_hash) VALUES($1,$2,$3,$4)",
      [username, display, req.body.role, hash],
    );
    redirect(
      req,
      res,
      "Account created. Share the password privately with the member.",
      "household",
    );
  });
  app.post("/admin/users/:id", requireAdmin, async (req, res) => {
    const target = id(req.params.id);
    const action = req.body.action;
    const hash =
      action === "save" && req.body.password
        ? await passwordHash(req.body.password)
        : null;
    await transaction(db, async (c) => {
      await c.query("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE");
      const account = (
        await c.query("SELECT * FROM users WHERE id=$1", [target])
      ).rows[0];
      if (!account) problem("Account not found.", 404);
      if (action === "remove") {
        if (target === req.session.user.id)
          problem("You cannot remove your own account.");
        if (req.body.confirmUsername !== account.username)
          problem("Type the username to confirm removal.");
        const sharedChores = (
          await c.query(
            "SELECT chore_id FROM chore_participants WHERE user_id=$1",
            [target],
          )
        ).rows.map((r) => r.chore_id);
        const sharedSeries = (
          await c.query(
            "SELECT series_id FROM series_participants WHERE user_id=$1",
            [target],
          )
        ).rows.map((r) => r.series_id);
        await c.query(
          "DELETE FROM chore_requests WHERE user_id=$1 OR chore_id IN (SELECT id FROM chores WHERE user_id=$1)",
          [target],
        );
        // Foreign keys remove owned tasks, schedules, memberships, points and account data.
        await c.query("DELETE FROM users WHERE id=$1", [target]);
        await c.query(
          "DELETE FROM chore_requests WHERE chore_id IN (SELECT c.id FROM chores c WHERE c.id=ANY($1::int[]) AND NOT EXISTS (SELECT 1 FROM chore_members m WHERE m.chore_id=c.id))",
          [sharedChores],
        );
        await c.query(
          "DELETE FROM chores c WHERE c.id=ANY($1::int[]) AND NOT EXISTS (SELECT 1 FROM chore_members m WHERE m.chore_id=c.id)",
          [sharedChores],
        );
        await c.query(
          "DELETE FROM chore_series s WHERE s.id=ANY($1::int[]) AND NOT EXISTS (SELECT 1 FROM series_members m WHERE m.series_id=s.id)",
          [sharedSeries],
        );
      } else if (action === "save") {
        const display = text(req.body.displayName, "Display name", 80);
        if (!["admin", "member"].includes(req.body.role))
          problem("Choose a valid role.");
        if (target === req.session.user.id && req.body.role !== "admin")
          problem("You cannot remove your own admin role.");
        await c.query(
          "UPDATE users SET display_name=$1,role=$2,password_hash=COALESCE($3,password_hash),session_version=session_version+1 WHERE id=$4",
          [display, req.body.role, hash, target],
        );
      } else problem("Invalid account action.");
      if (
        !(
          await c.query(
            "SELECT id FROM users WHERE role='admin' AND deleted_at IS NULL",
          )
        ).rowCount
      )
        problem("At least one active admin is required.");
    });
    redirect(
      req,
      res,
      action === "remove"
        ? "Account and its history permanently deleted."
        : "Account updated. Existing sessions for that account have been revoked.",
      "household",
    );
  });
}
module.exports = { installAdmin, date, transaction, problem };
