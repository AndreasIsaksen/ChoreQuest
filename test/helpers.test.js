const test = require("node:test");
const assert = require("node:assert/strict");
const { filterChoresByMonth, groupChoresByDate } = require("../src/helpers");

test("filterChoresByMonth returns only chores in selected month", () => {
  const chores = [
    { id: 1, due_date: "2026-10-03" },
    { id: 2, due_date: "2026-10-27" },
    { id: 3, due_date: "2026-11-01" },
  ];

  assert.deepEqual(
    filterChoresByMonth(chores, "2026-10").map((c) => c.id),
    [1, 2],
  );
});

test("groupChoresByDate buckets chores by due date", () => {
  const grouped = groupChoresByDate([
    { id: 1, due_date: "2026-10-01" },
    { id: 2, due_date: "2026-10-01" },
    { id: 3, due_date: "2026-10-02" },
  ]);

  assert.equal(grouped["2026-10-01"].length, 2);
  assert.equal(grouped["2026-10-02"].length, 1);
});

test("month filtering handles PostgreSQL date objects", () => {
  assert.equal(
    filterChoresByMonth([{ due_date: new Date(2026, 9, 3) }], "2026-10").length,
    1,
  );
});

test("calendar includes leap day and starts on Monday", () => {
  const { calendarDays } = require("../src/helpers");
  const days = calendarDays("2028-02");
  assert.equal(days.length, 42);
  assert.equal(new Date(days[0].key + "T12:00:00Z").getUTCDay(), 1);
  assert.ok(days.some((d) => d.key === "2028-02-29" && d.inMonth));
});
