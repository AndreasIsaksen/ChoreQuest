const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { groupSchedulesByTitle, choreReturnTo } = require("../src/helpers");

test("schedule groups keep distinct rewards without inflating repeated member points", () => {
  const reward = { id: 2, name: "Alex", points: 5 };
  const groups = groupSchedulesByTitle([
    { id: 1, title: "Laundry", point_rewards: [reward] },
    { id: 2, title: "Laundry", point_rewards: [reward, { ...reward, points: 13 }] },
    { id: 3, title: "Dishes", point_rewards: null },
  ]);
  assert.deepEqual(groups.map(g => g.title), ["Dishes", "Laundry"]);
  assert.equal(groups[1].items.length, 2);
  assert.deepEqual(groups[1].rewards.map(p => p.points), [5, 13]);
});

test("task returns preserve dashboard filters and reject external or malformed paths", () => {
  assert.equal(choreReturnTo("/dashboard?section=chores&status=open#old", 7), "/dashboard?section=chores&status=open#chore-7");
  for (const value of [undefined, "//example.com", "https://example.com", "/dashboard/other", "/dashboard?x=\\evil", "/dashboard\r\nLocation: bad"])
    assert.equal(choreReturnTo(value, 7), "/dashboard?section=chores#chore-7");
});

test("nested schedule links reveal ancestors, scroll and move keyboard focus", () => {
  class Details {}
  const group = new Details(), target = new Details();
  target.parentElement = group;
  target.scrollIntoView = options => { target.scrolled = options.block; };
  target.focus = options => { target.focused = options.preventScroll; };
  const listeners = {};
  vm.runInNewContext(fs.readFileSync("src/public/app.js", "utf8"), {
    location: { hash: "#schedule-7" }, HTMLDetailsElement: Details,
    window: { addEventListener(event, fn) { listeners[event] = fn; }, requestAnimationFrame(fn) { fn(); } },
    document: { getElementById: id => id === "schedule-7" ? target : null, querySelectorAll: () => [] },
  });
  assert.equal(target.open, true);
  assert.equal(group.open, true);
  assert.equal(target.scrolled, "start");
  assert.equal(target.focused, true);
  assert.equal(target.tabIndex, -1);
  assert.ok(listeners.hashchange && listeners.load && listeners.pageshow);
  target.scrolled = null;
  listeners.pageshow();
  assert.equal(target.scrolled, "start");
});

test("a chore deep link expands its details before scrolling and focusing the row", () => {
  const details = { open: false };
  const target = {
    querySelector: () => details,
    scrollIntoView() { assert.equal(details.open, true); },
    focus() { this.focused = true; },
  };
  vm.runInNewContext(fs.readFileSync("src/public/app.js", "utf8"), {
    location: { hash: "#chore-7" }, HTMLDetailsElement: class {},
    window: { addEventListener() {} },
    document: { getElementById: id => id === "chore-7" ? target : null, querySelectorAll: () => [] },
  });
  assert.equal(details.open, true);
  assert.equal(target.focused, true);
});
