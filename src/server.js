require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcrypt");
const pool = require("./db");
const { migrate } = require("./migrate");
const { installAdmin, date, transaction, problem } = require("./admin");
const { dateKey, formatDate, calendarDays, todayKey } = require("./helpers");

const { translator, languageFromCookie, languageReturnTo } = require("./i18n");

function createApp({ db = pool, env = process.env } = {}) {
  const {
    createNotifications,
    installNotifications,
  } = require("./notifications");
  const notifications = createNotifications(db, env);
  const app = express();
  const secureSetting = env.SESSION_COOKIE_SECURE ?? "true";
  if (!["true", "false"].includes(secureSetting)) {
    throw new Error("SESSION_COOKIE_SECURE must be true or false");
  }
  const cookieOptions = {
    httpOnly: true,
    sameSite: "lax",
    secure: secureSetting === "true",
    path: "/",
  };
  // Trust only explicitly configured proxy addresses/subnets, never arbitrary headers.
  if (env.TRUST_PROXY)
    app.set(
      "trust proxy",
      env.TRUST_PROXY.split(",").map((value) => value.trim()),
    );

  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "views"));

  app.use("/assets", express.static(path.join(__dirname, "public")));
  app.get("/sw.js", (req, res) => {
    res.set("Cache-Control", "no-cache");
    res.sendFile(path.join(__dirname, "public", "sw.js"));
  });
  app.use(express.json({ limit: "16kb" }));
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    const language = languageFromCookie(req.headers.cookie);
    res.locals.language = language;
    res.locals.t = translator(language);
    res.locals.formatDate = (value) => formatDate(value, language);
    res.locals.languageReturnTo = languageReturnTo(req.originalUrl);
    res.set("Content-Language", language);
    next();
  });
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 250,
      standardHeaders: true,
      legacyHeaders: false,
      handler: (req, res) =>
        res
          .status(429)
          .send(res.locals.t("Too many requests, please try again later.")),
    }),
  );
  app.use(
    session({
      secret: env.SESSION_SECRET || "local-dev-secret",
      resave: false,
      saveUninitialized: false,
      cookie: cookieOptions,
    }),
  );
  app.use((req, res, next) => {
    if (!req.session.csrfToken)
      req.session.csrfToken = crypto.randomBytes(32).toString("hex");
    res.locals.csrfToken = req.session.csrfToken;
    next();
  });
  app.use((req, res, next) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
    if (
      req.body?._csrf === req.session.csrfToken ||
      req.headers["x-csrf-token"] === req.session.csrfToken
    ) {
      return next();
    }
    return res.status(403).send(res.locals.t("Invalid CSRF token"));
  });

  app.post("/language", (req, res) => {
    if (!["en", "nb"].includes(req.body.language))
      return res.status(400).send(res.locals.t("Invalid language."));
    res.cookie("chorequest_language", req.body.language, {
      ...cookieOptions,
      maxAge: 365 * 24 * 60 * 60 * 1000,
    });
    return res.redirect(303, languageReturnTo(req.body.returnTo));
  });

  // Recheck account state on every request so removal and password/role changes revoke sessions.
  app.use(async (req, res, next) => {
    if (!req.session.user) return next();
    const account = (
      await db.query(
        "SELECT id, username, display_name, role, deleted_at, session_version FROM users WHERE id=$1",
        [req.session.user.id],
      )
    ).rows[0];
    if (
      !account ||
      account.deleted_at ||
      account.session_version !== req.session.user.sessionVersion
    ) {
      return req.session.destroy((err) =>
        err ? next(err) : res.redirect("/login"),
      );
    }
    req.session.user.displayName = account.display_name;
    req.session.user.role = account.role;
    next();
  });

  function requireAuth(req, res, next) {
    if (!req.session.user) return res.redirect("/login");
    next();
  }

  function requireAdmin(req, res, next) {
    if (!req.session.user || req.session.user.role !== "admin")
      return res.status(403).send(res.locals.t("Forbidden"));
    next();
  }

  app.get("/", (req, res) => {
    if (!req.session.user) return res.redirect("/login");
    return res.redirect("/dashboard");
  });

  app.get("/login", (req, res) => {
    if (req.session.user) return res.redirect("/");
    return res.render("login", { error: null });
  });

  app.post("/login", async (req, res) => {
    const { username, password } = req.body;
    if (typeof username !== "string" || typeof password !== "string")
      return res
        .status(401)
        .render("login", { error: "Invalid username or password" });
    const result = await db.query(
      "SELECT id, username, display_name, role, password_hash, session_version FROM users WHERE lower(username) = lower($1) AND deleted_at IS NULL",
      [username],
    );

    if (!result.rows[0])
      return res
        .status(401)
        .render("login", { error: "Invalid username or password" });

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid)
      return res
        .status(401)
        .render("login", { error: "Invalid username or password" });

    await new Promise((resolve, reject) =>
      req.session.regenerate((err) => (err ? reject(err) : resolve())),
    );
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
    req.session.user = {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role,
      sessionVersion: user.session_version,
    };

    await new Promise((resolve, reject) =>
      req.session.save((err) => (err ? reject(err) : resolve())),
    );
    return res.redirect("/");
  });

  app.post("/logout", (req, res, next) => {
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie("connect.sid", cookieOptions);
      return res.redirect("/login");
    });
  });

  app.get("/profile", requireAuth, (req, res) => res.redirect("/dashboard"));
  app.get("/admin", requireAuth, requireAdmin, (req, res) =>
    res.redirect("/dashboard?section=administration"),
  );

  app.get("/dashboard", requireAuth, async (req, res) => {
    const user = req.session.user;
    const isAdmin = user.role === "admin";
    const section = [
      "overview",
      "chores",
      "requests",
      "household",
      "administration",
    ].includes(req.query.section)
      ? req.query.section
      : "overview";
    if (["household", "administration"].includes(section) && !isAdmin)
      return res.status(403).send(res.locals.t("Forbidden"));
    const selectedMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month || "")
      ? req.query.month
      : todayKey().slice(0, 7);
    const member =
      isAdmin &&
      (req.query.member === "unassigned" ||
        /^\d+$/.test(req.query.member || ""))
        ? req.query.member
        : "";
    const status = ["open", "completed", "overdue", "removed"].includes(
      req.query.status,
    )
      ? req.query.status
      : "all";
    const choreType = ["quick", "standard"].includes(req.query.choreType) ? req.query.choreType : "all";
    const view = req.query.view === "calendar" ? "calendar" : "list";
    await transaction(db, async (c) => {
      await c.query("SELECT generate_chore_occurrences($1::date)", [
        todayKey(),
      ]);
      await c.query("SELECT process_points($1::date)", [todayKey()]);
    });
    const choresResult = await db.query(
      `SELECT c.id, c.user_id, c.title, c.description, to_char(c.due_date, 'YYYY-MM-DD') AS due_date,
       ${isAdmin ? "c.points" : "(SELECT m.points FROM chore_member_points m WHERE m.chore_id=c.id AND m.user_id=$1)"} AS points,
       EXISTS(SELECT 1 FROM chore_participants p WHERE p.chore_id=c.id AND p.points IS NOT NULL) AS custom_points,
       (SELECT jsonb_agg(jsonb_build_object('name',u.display_name,'points',m.points) ORDER BY u.display_name) FROM chore_member_points m JOIN users u ON u.id=m.user_id WHERE m.chore_id=c.id) AS point_rewards,
       c.is_quick, c.removed_at, c.completed, c.due_time, chore_deadline(c.due_date,c.due_time)<=now() AS overdue, to_char(COALESCE(c.due_date, (c.completed_at AT TIME ZONE 'Europe/Oslo')::date, CASE WHEN c.completed THEN (c.created_at AT TIME ZONE 'Europe/Oslo')::date END), 'YYYY-MM-DD') AS calendar_date, (c.completed AND c.completed_at > chore_deadline(c.due_date,c.due_time)) AS completed_late, c.series_id, c.cooperative, c.template_id, to_char(c.window_start, 'YYYY-MM-DD') AS window_start, c.completed_at,
       COALESCE((SELECT string_agg(u.display_name, ', ' ORDER BY u.display_name) FROM chore_members m JOIN users u ON u.id=m.user_id WHERE m.chore_id=c.id),'Unassigned') AS display_name,
       ARRAY(SELECT m.user_id FROM chore_members m WHERE m.chore_id=c.id) AS member_ids
       FROM chores c
       WHERE (c.removed_at IS NULL OR c.removed_history) ${isAdmin ? "" : "AND EXISTS (SELECT 1 FROM chore_members m WHERE m.chore_id=c.id AND m.user_id=$1)"} ORDER BY c.due_date, c.id`,
      isAdmin ? [] : [user.id],
    );
    const requestsResult = await db.query(
      `SELECT r.*, to_char(r.proposed_due_date, 'YYYY-MM-DD') AS proposed_due_date, u.display_name,
       recipient.display_name AS recipient_name, c.title AS chore_title FROM chore_requests r JOIN users u ON u.id = r.user_id
       LEFT JOIN users recipient ON recipient.id=r.recipient_id
       LEFT JOIN chores c ON c.id = r.chore_id ${isAdmin ? "" : "WHERE r.user_id = $1 OR r.recipient_id = $1"} ORDER BY r.created_at DESC`,
      isAdmin ? [] : [user.id],
    );
    const users = isAdmin
      ? (
          await db.query(
            "SELECT u.id, username, display_name, role, deleted_at, notify_due, notify_assignment, notify_requests, (SELECT count(*) FROM push_subscriptions s WHERE s.user_id=u.id) AS push_devices, p.weekly_points, p.permanent_points FROM users u JOIN member_points p ON p.user_id=u.id ORDER BY deleted_at NULLS FIRST, display_name",
          )
        ).rows
      : [];
    const series = (
      await db.query(
        `SELECT s.*, ${isAdmin ? "s.points" : "COALESCE((SELECT p.points FROM series_participants p WHERE p.series_id=s.id AND p.user_id=$1),s.points)"} AS points,
             EXISTS(SELECT 1 FROM series_participants p WHERE p.series_id=s.id AND p.points IS NOT NULL) AS custom_points,
             (SELECT jsonb_agg(jsonb_build_object('name',u.display_name,'points',COALESCE(p.points,s.points)) ORDER BY u.display_name) FROM series_members m JOIN users u ON u.id=m.user_id LEFT JOIN series_participants p ON p.series_id=m.series_id AND p.user_id=m.user_id WHERE m.series_id=s.id) AS point_rewards,
             to_char(s.starts_on, 'YYYY-MM-DD') AS starts_on,
             to_char(CASE WHEN s.weekdays IS NULL THEN s.starts_on ELSE
               (SELECT min(day::date) FROM generate_series(greatest(s.starts_on,(now() AT TIME ZONE 'Europe/Oslo')::date)::timestamp,
               greatest(s.starts_on,(now() AT TIME ZONE 'Europe/Oslo')::date)::timestamp+interval '6 days',interval '1 day') day
               WHERE extract(isodow FROM day)::smallint=ANY(s.weekdays)) END,'YYYY-MM-DD') AS next_on,
             ARRAY(SELECT m.user_id FROM series_members m WHERE m.series_id=s.id) AS member_ids,
             COALESCE((SELECT string_agg(u.display_name, ', ' ORDER BY u.display_name) FROM series_members m JOIN users u ON u.id=m.user_id WHERE m.series_id=s.id),'') AS display_name
             FROM chore_series s WHERE s.removed_at IS NULL ${isAdmin ? "" : "AND s.active AND EXISTS (SELECT 1 FROM series_members m WHERE m.series_id=s.id AND m.user_id=$1)"} ORDER BY s.id DESC`,
        isAdmin ? [] : [user.id],
      )
    ).rows;
    const library = isAdmin
      ? (
          await db.query(
            "SELECT * FROM chore_templates WHERE removed_at IS NULL ORDER BY lower(title),id",
          )
        ).rows
      : [];
    const pointBalance = (
      await db.query("SELECT * FROM member_points WHERE user_id=$1", [user.id])
    ).rows[0] || { weekly_points: 0, permanent_points: 0 };
    const activeUsers = users.filter((u) => !u.deleted_at);
    const historyMember =
      /^\d+$/.test(req.query.historyMember || "") &&
      Number.isSafeInteger(Number(req.query.historyMember)) &&
      Number(req.query.historyMember) <= 2147483647
        ? req.query.historyMember
        : "";
    const historyPage = /^\d+$/.test(req.query.historyPage || "")
      ? Math.max(1, Math.min(1000000, Number(req.query.historyPage)))
      : 1;
    let pointHistory = [],
      historyCount = 0;
    if (isAdmin && section === "administration") {
      const filter = historyMember ? Number(historyMember) : null;
      historyCount = Number(
        (
          await db.query(
            "SELECT count(*) FROM point_ledger WHERE kind='admin_adjustment' AND ($1::int IS NULL OR user_id=$1)",
            [filter],
          )
        ).rows[0].count,
      );
      pointHistory = (
        await db.query(
          `SELECT l.*, u.display_name AS member_name, a.display_name AS actor_name,
        to_char(l.created_at AT TIME ZONE 'Europe/Oslo','YYYY-MM-DD HH24:MI:SS') AS edited_at
        FROM point_ledger l JOIN users u ON u.id=l.user_id LEFT JOIN users a ON a.id=l.actor_id
        WHERE l.kind='admin_adjustment' AND ($1::int IS NULL OR l.user_id=$1)
        ORDER BY l.created_at DESC,l.id DESC LIMIT 50 OFFSET $2`,
          [filter, (historyPage - 1) * 50],
        )
      ).rows;
    }
    const allChores = choresResult.rows.map((c) => ({
      ...c,
      display_name: c.member_ids.length
        ? c.display_name
        : res.locals.t("Unassigned"),
      due_date: c.due_date ? dateKey(c.due_date) : null,
    }));
    const scoped = allChores.filter(
      (c) =>
        !member ||
        (member === "unassigned"
          ? c.member_ids.length === 0
          : c.member_ids.includes(Number(member))),
    );
    const today = todayKey();
    const stats = {
      total: scoped.filter((c) => !c.removed_at).length,
      completed: scoped.filter((c) => !c.removed_at && c.completed).length,
      overdue: scoped.filter(
        (c) =>
          !c.removed_at && !c.completed && c.overdue,
      ).length,
      pending: requestsResult.rows.filter((r) => r.status === "pending").length,
    };
    const monthEnd = calendarDays(selectedMonth)
      .filter((d) => d.inMonth)
      .at(-1).key;
    const chores = scoped.filter(
      (c) =>
        (choreType === "all" || (choreType === "quick" ? c.is_quick : !c.is_quick)) &&
        (view !== "calendar" ||
          !c.calendar_date ||
          (c.calendar_date &&
            (c.window_start
              ? c.window_start <= monthEnd &&
                c.calendar_date >= selectedMonth + "-01"
              : c.calendar_date.startsWith(selectedMonth)))) &&
        (status === "all" ||
          (status === "removed"
            ? !!c.removed_at
            : !c.removed_at &&
              (status === "completed"
                ? c.completed
                : !c.completed &&
                  (status !== "overdue" ||
                    c.overdue)))),
    );
    const flash = req.session.flash;
    delete req.session.flash;
    res.render("dashboard", {
      user,
      pointBalance,
      isAdmin,
      section,
      selectedMonth,
      member,
      status,
      view,
      choreType,
      users,
      activeUsers,
      requestMembers: (
        await db.query(
          "SELECT id, display_name FROM users WHERE deleted_at IS NULL AND id<>$1 ORDER BY display_name",
          [user.id],
        )
      ).rows,
      pointHistory,
      historyMember,
      historyPage,
      historyCount,
      adjustmentRequestId: crypto.randomUUID(),
      series,
      upcomingSchedules: series.filter((s) =>
        choreType !== "quick" && s.active && (s.next_on || s.starts_on) > today && ["all", "open"].includes(status) &&
        (!member || (member === "unassigned" ? !s.member_ids.length : s.member_ids.includes(Number(member))))
      ).sort((a, b) => (a.next_on || a.starts_on).localeCompare(b.next_on || b.starts_on) || a.id - b.id),
      library,
      allChores,
      chores,
      requests: requestsResult.rows,
      stats,
      today,
      flash,
      days: calendarDays(selectedMonth),
      requestLabels: {
        different_chore: "Change a chore",
        due_date_change: "Change a due date",
        other: "Something else",
      },
    });
  });

  app.post("/chores/:id/toggle", requireAuth, async (req, res) => {
    if (
      !["true", "false"].includes(req.body.completed || "") &&
      req.body.completed !== undefined
    )
      problem("Invalid completion state.");
    const result = await transaction(db, (c) =>
      c.query(
        "UPDATE chores SET completed = COALESCE($3::boolean, NOT completed), completed_at=CASE WHEN COALESCE($3::boolean, NOT completed) THEN COALESCE(completed_at,now()) ELSE NULL END WHERE id = $1 AND removed_at IS NULL AND EXISTS (SELECT 1 FROM chore_members m WHERE m.chore_id=chores.id AND m.user_id=$2) AND (window_start IS NULL OR window_start <= (now() AT TIME ZONE 'Europe/Oslo')::date) RETURNING id",
        [req.params.id, req.session.user.id, req.body.completed ?? null],
      ),
    );
    if (!result.rowCount)
      problem("This chore is not assigned to you or has not started yet.", 403);
    req.session.flash = "Your change has been saved.";
    return res.redirect("/dashboard");
  });

  app.post("/requests", requireAuth, async (req, res) => {
    const { choreId, requestType, details, proposedDueDate, recipientId } =
      req.body;
    const proposed = date(proposedDueDate);
    if (
      recipientId &&
      (!/^\d+$/.test(recipientId) ||
        Number(recipientId) > 2147483647 ||
        Number(recipientId) === req.session.user.id ||
        !(
          await db.query(
            "SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL",
            [recipientId],
          )
        ).rowCount)
    )
      problem("Choose an active account.");
    if (
      !["different_chore", "due_date_change", "other"].includes(requestType) ||
      typeof details !== "string" ||
      !details.trim()
    )
      return res
        .status(400)
        .send(res.locals.t("Please describe your request."));
    if (choreId) {
      const owned = await db.query(
        "SELECT id FROM chores WHERE id = $1 AND removed_at IS NULL AND EXISTS (SELECT 1 FROM chore_members m WHERE m.chore_id=chores.id AND m.user_id=$2)",
        [choreId, req.session.user.id],
      );
      if (!owned.rows.length)
        return res
          .status(403)
          .send(
            res.locals.t("You can only request changes to your own chores."),
          );
    }
    await db.query(
      `INSERT INTO chore_requests (user_id, chore_id, request_type, details, proposed_due_date, recipient_id)
       VALUES ($1, NULLIF($2, '')::INT, $3, $4, $5::DATE, $6::INT)`,
      [
        req.session.user.id,
        choreId || "",
        requestType,
        details,
        proposed,
        recipientId || null,
      ],
    );
    req.session.flash = "Your change has been saved.";
    return res.redirect("/dashboard?section=requests");
  });

  installAdmin(app, db, requireAdmin);
  installNotifications(app, db, requireAuth, requireAdmin, notifications);

  app.post("/admin/requests/:id", requireAdmin, async (req, res) => {
    const { status, adminNote, approvedDueDate } = req.body;

    if (!["pending", "approved", "rejected"].includes(status))
      problem("Choose a valid decision.");
    const due = date(approvedDueDate);
    await transaction(db, async (c) => {
      const request = (
        await c.query("SELECT * FROM chore_requests WHERE id=$1 FOR UPDATE", [
          req.params.id,
        ])
      ).rows[0];
      if (!request) problem("Request not found.", 404);
      if (status === "approved" && request.chore_id) {
        const chore = (
          await c.query("SELECT * FROM chores WHERE id=$1 FOR UPDATE", [
            request.chore_id,
          ])
        ).rows[0];
        if (chore?.removed_at)
          problem("Removed chores cannot be changed.", 409);
        if (due && chore?.series_id)
          problem(
            "Recurring chores follow their completion windows. A request cannot change a recurring deadline.",
          );
        if (due && chore?.window_start && due < dateKey(chore.window_start))
          problem("The due date must be on or after the start date.");
        if (due)
          await c.query("UPDATE chores SET due_date=$1 WHERE id=$2", [
            due,
            request.chore_id,
          ]);
      }
      await c.query(
        "UPDATE chore_requests SET status=$1,admin_note=$2 WHERE id=$3",
        [status, adminNote || null, request.id],
      );
    });

    req.session.flash = "Your change has been saved.";
    return res.redirect("/dashboard?section=requests");
  });

  app.use((err, req, res, next) => {
    if (err.status || err.code === "23505") {
      return res.status(err.status || 409).render("error", {
        message:
          err.code === "23505"
            ? "That username is already in use, including removed accounts."
            : err.message,
      });
    }
    console.error(err);
    res.status(500).send(res.locals.t("Unexpected server error"));
  });

  return app;
}

if (require.main === module) {
  (async () => {
    await migrate(pool);
    const maintain = () =>
      transaction(pool, async (c) => {
        await c.query("SELECT generate_chore_occurrences($1::date)", [
          todayKey(),
        ]);
        await c.query("SELECT process_points($1::date)", [todayKey()]);
      });
    const notifications = require("./notifications").createNotifications(pool);
    await maintain();
    await notifications.maintain();
    const timer = setInterval(
      () =>
        maintain()
          .then(() => notifications.maintain())
          .catch(console.error),
      60000,
    );
    timer.unref();
    const port = Number(process.env.PORT || 3000);
    createApp().listen(port, () =>
      console.log(`ChoreQuest running on port ${port}`),
    );
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
module.exports = { createApp };
