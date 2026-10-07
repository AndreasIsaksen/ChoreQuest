const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ejs = require("ejs");
const { translator } = require("../src/i18n");
const { formatDate, calendarDays } = require("../src/helpers");
const norwegian = require("../src/locales/nb.json");

test("dates and interpolated messages use the selected language", () => {
  assert.equal(formatDate("2026-09-28", "nb"), "28. sep. 2026");
  assert.equal(formatDate("2026-09-28"), "28 Sept 2026");
  assert.equal(translator("nb")("{completed} of {total} chores completed.", { completed: 2, total: 4 }), "2 av 4 oppgaver fullført.");
  assert.equal(translator("en")("Missing key"), "Missing key");
});

test("weekday summaries show translated days and the saved deadline time", () => {
  const file = path.join(__dirname, "../src/views/partials/schedule-summary.ejs");
  for (const [language, expected] of [["en", "Mon, Wed, Fri"], ["nb", "Man, Ons, Fre"]]) {
    const html = ejs.render(fs.readFileSync(file,"utf8"), {
      item: { weekdays: [1,3,5], due_time: "14:00:00" }, language, t: translator(language),
    });
    assert.ok(html.includes(expected));
    assert.match(html,/14:00/);
  }
});

test("individual point controls and reward summaries translate and escape member names", () => {
  const name = 'Member <script>alert(1)</script>';
  for (const language of ["en","nb"]) {
    const t = translator(language);
    const controls = ejs.render(fs.readFileSync(path.join(__dirname,"../src/views/partials/assignment-members.ejs"),"utf8"), {
      people:[{id:2,display_name:name}], defaultPoints:7, t,
    });
    assert.match(controls,/name="memberPoints_2"/);
    assert.match(controls,/value="7"/);
    assert.doesNotMatch(controls,/<script>/);
    const summary = ejs.render(fs.readFileSync(path.join(__dirname,"../src/views/partials/member-rewards.ejs"),"utf8"), {
      item:{custom_points:true,point_rewards:[{name,points:13}]},t,
    });
    assert.doesNotMatch(summary,/<script>/);
    assert.match(summary,/13/);
    assert.ok(summary.includes(language==="nb"?"Poeng per medlem":"Points by member"));
  }
});

test("populated member/admin views translate copy without changing user data or form values", () => {
  const userContent = "Chores <script>alert(1)</script>";
  const chores = [false, true].map((completed, i) => ({
    id: i + 1, title: userContent, description: "Keep my description",
    completed, completed_late: completed, overdue: !completed, due_time: "14:00:00", points: 10, member_ids: [1, 2],
    display_name: "English", cooperative: true, series_id: 1,
    window_start: "2026-09-01", due_date: "2026-09-20",
  }));
  const people = [1, 2, 3].map((id) => ({
    id, display_name: "English", username: "member" + id,
    role: id === 1 ? "admin" : "member", deleted_at: id === 3,
    weekly_points: 10, permanent_points: 20,
  }));
  for (const language of ["en", "nb"]) {
    const t = (key, values) => {
      assert.ok(key === "" || Object.hasOwn(norwegian, key), `Missing translation: ${key}`);
      return translator(language)(key, values);
    };
    for (const isAdmin of [false, true]) {
      for (const section of ["overview", "chores", "requests", ...(isAdmin ? ["household", "administration"] : [])]) {
        const html = ejs.render(fs.readFileSync(path.join(__dirname, "../src/views/dashboard.ejs"), "utf8"), {
          t, language, languageReturnTo: "/dashboard", csrfToken: "test-token",
          formatDate: (value) => formatDate(value, language), isAdmin, section,
          user: { id: 1, displayName: "English" }, pointBalance: { weekly_points: 10, permanent_points: 20 },
          pointHistory: [{member_name:'English',actor_name:'Admin',amount:-5,account_type:'weekly',balance_before:10,balance_after:5,reason:'Correction',edited_at:'2026-09-28 12:00:00'}], historyCount:1,historyPage:1,historyMember:'',adjustmentRequestId:'test-request',
          users: people, activeUsers: people.slice(0, 2),
          chores, allChores: chores, selectedMonth: "2026-09", today: "2026-09-28",
          choreType: "all", view: "calendar", member: "", status: "all", days: calendarDays("2026-09"),
          stats: { total: 2, completed: 1, overdue: 1, pending: 1 }, flash: "Your change has been saved.",
          library: [{ id: 1, title: userContent, description: "", points: 10 }],
          upcomingSchedules: [{ id: 3, title: userContent, description: userContent, cooperative: true, display_name: "English", points: 10, starts_on: "2026-10-05", interval_count: 1, interval_unit: "weeks" }],
          series: [true, false].map((active, i) => ({ id: i + 1, title: userContent, cooperative: active, member_ids: [1, 2], starts_on: "2026-09-01", interval_count: i + 1, interval_unit: "weeks", active })),
          requestLabels: { different_chore: "Change a chore", due_date_change: "Change a due date", other: "Something else" },
          requests: ["pending", "approved", "rejected"].map((status, i) => ({ id: i + 1, status, request_type: "other", display_name: "English", chore_title: userContent, details: userContent, proposed_due_date: "2026-09-30", admin_note: "My response" })),
        }, { filename: path.join(__dirname, "../src/views/dashboard.ejs") });
        // Task priority must also follow DOM order for keyboard and screen readers.
        if (section === "chores") {
          assert.ok(html.indexOf('id="household-plan"') < html.indexOf('id="upcoming-chores"'));
          assert.ok(html.indexOf('id="household-plan"') < html.indexOf('aria-label="' + t('Your points') + '"'));
        }
        if (section === "requests") {
          const form = html.indexOf('action="/requests"');
          const history = html.indexOf('class="request-card"');
          assert.ok(isAdmin ? history < form : form < history);
          assert.equal(html.match(/action="\/requests"/g).length, 1);
        }
        if (section === "administration") {
          assert.ok(html.indexOf('id="chore-library"') < html.indexOf('id="point-accounts"'));
        }
        assert.ok(html.indexOf('id="push-device"') < html.indexOf('class="main-footer"'));
        if (section !== "household") assert.match(html, /Chores &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
        assert.doesNotMatch(html, /<script>alert/);
        assert.match(html, /English/);
        if (["overview", "chores"].includes(section)) {
          assert.match(html, /class="badge overdue"/);
          assert.match(html, /class="badge completed"/);
          assert.match(html, /name="completed" value="true"/);
          if (language === "nb") {
            assert.match(html, /Fullført etter fristen/);
            assert.match(html, /28\. sep\. 2026/);

          }
        }
        if (section === "administration" && language === "nb") assert.match(html, /Hver 2\. uke/);
        if (section === "requests" && isAdmin) assert.match(html, /value="approved"/);
      }
    }
  }
});
