const test = require("node:test");
const assert = require("node:assert/strict");
const { upcomingOccurrences } = require("../src/upcoming");

const schedule = { id: 1, active: true, starts_on: "2028-01-31", interval_count: 1, interval_unit: "months", generated_count: 0 };

test("future calendar windows belong to their deadline month and retain anchored month boundaries", () => {
  const series = [{ ...schedule, points: 7, member_ids: [2] }];
  const february = upcomingOccurrences(series, "2028-01-01", "2028-02");
  assert.deepEqual(february.map(s => [s.window_start, s.due_date]), [["2028-01-31", "2028-02-28"]]);
  const march = upcomingOccurrences(series, "2028-01-01", "2028-03");
  assert.deepEqual(march.map(s => [s.window_start, s.due_date]), [["2028-02-29", "2028-03-30"]]);
  assert.deepEqual(upcomingOccurrences(series, "2028-01-01", "2028-01"), []);
  assert.equal(february[0].points, 7);
  assert.deepEqual(february[0].member_ids, [2]);
  assert.equal(series[0].generated_count, 0);
});

test("lists preview the next future period after current and already generated periods", () => {
  assert.deepEqual(upcomingOccurrences([{ ...schedule, generated_count: 1 }], "2028-02-10").map(s => s.window_start), ["2028-02-29"]);
  assert.deepEqual(upcomingOccurrences([{ ...schedule, generated_count: 2 }], "2028-02-10").map(s => s.window_start), ["2028-03-31"]);
  assert.deepEqual(upcomingOccurrences([{ ...schedule, starts_on: "2035-01-31" }], "2028-02-10").map(s => s.window_start), ["2035-01-31"]);
  assert.deepEqual(upcomingOccurrences([schedule], "2028-03-01", "2028-02"), []);
  assert.deepEqual(upcomingOccurrences([{ ...schedule, active: false }, { ...schedule, removed_at: "2028-01-01" }], "2028-01-01"), []);
});

test("weekday and multi-week schedules retain their exact dates and unique links", () => {
  const weekdays = { ...schedule, starts_on: "2028-02-01", weekdays: [1, 3, 5], interval_unit: "weeks" };
  const next = upcomingOccurrences([weekdays], "2028-02-02");
  assert.equal(next[0].window_start, "2028-02-04");
  assert.equal(next[0].due_date, "2028-02-04");
  const month = upcomingOccurrences([weekdays], "2028-02-02", "2028-02");
  assert.equal(month.length, 11);
  assert.equal(new Set(month.map(s => s.preview_id)).size, month.length);
  const weekly = upcomingOccurrences([{ ...schedule, starts_on: "2028-02-01", interval_count: 2, interval_unit: "weeks" }], "2028-02-02", "2028-02");
  assert.deepEqual(weekly.map(s => [s.window_start, s.due_date]), [["2028-02-15", "2028-02-28"]]);
  const march = upcomingOccurrences([{ ...schedule, starts_on: "2028-02-01", interval_count: 2, interval_unit: "weeks" }], "2028-02-02", "2028-03");
  assert.deepEqual(march.map(s => [s.window_start, s.due_date]), [["2028-02-29", "2028-03-13"], ["2028-03-14", "2028-03-27"]]);
});
