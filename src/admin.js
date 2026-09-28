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
  const starts = date(b.startsOn, b.schedule === "recurring");
  const due = date(b.dueDate);
  const recurring = b.schedule === "recurring";
  if (b.schedule && !["once", "recurring"].includes(b.schedule))
    problem("Invalid schedule.");
  const count = Number(b.intervalCount);
  if (recurring) {
    if (
      !Number.isInteger(count) ||
      count < 1 ||
      count > 365 ||
      !["days", "weeks", "months"].includes(b.intervalUnit)
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
          "INSERT INTO chore_series(title,description,user_id,starts_on,interval_count,interval_unit,template_id,cooperative) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
          [
            template.title,
            template.description,
            member,
            starts,
            count,
            b.intervalUnit,
            template.id,
            cooperative,
          ],
        )
      : await c.query(
          "INSERT INTO chores(title,description,user_id,window_start,due_date,template_id,cooperative) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
          [
            template.title,
            template.description,
            member,
            starts,
            due,
            template.id,
            cooperative,
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
  const redirect = (req, res, message, section = "chores") => {
    req.session.flash = message;
    res.redirect("/dashboard?section=" + section);
  };
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
          "INSERT INTO chore_templates(title,description) VALUES($1,$2) RETURNING *",
          [title, description],
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
        await c.query("SELECT * FROM chore_templates WHERE id=$1 FOR SHARE", [
          id(req.params.id),
        ])
      ).rows[0];
      if (!template) problem("Chore not found.", 404);
      await assignChore(c, template, req.body);
    });
    redirect(
      req,
      res,
      "Chore added to the household plan. The definition stays in your library.",
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
      "UPDATE chore_templates SET title=$1,description=$2 WHERE id=$3 RETURNING id",
      [title, description, id(req.params.id)],
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
      if (!chore || chore.completed)
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
      if (!schedule) problem("Schedule not found.", 404);
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
        await c.query(
          "UPDATE users SET deleted_at=now(), session_version=session_version+1 WHERE id=$1",
          [target],
        );
        await c.query("UPDATE chore_series SET user_id=NULL WHERE user_id=$1", [
          target,
        ]);
        await c.query("DELETE FROM series_participants WHERE user_id=$1", [
          target,
        ]);
        await c.query(
          "DELETE FROM chore_participants WHERE user_id=$1 AND chore_id IN (SELECT id FROM chores WHERE NOT completed AND (due_date IS NULL OR due_date >= $2))",
          [target, todayKey()],
        );
        await c.query(
          "UPDATE chores SET user_id=NULL WHERE user_id=$1 AND NOT completed AND (due_date IS NULL OR due_date >= $2)",
          [target, todayKey()],
        );
      } else if (action === "restore") {
        await c.query(
          "UPDATE users SET deleted_at=NULL, session_version=session_version+1 WHERE id=$1",
          [target],
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
      "Account updated. Existing sessions for that account have been revoked.",
      "household",
    );
  });
}
module.exports = { installAdmin, date, transaction, problem };
