const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

test("schedule selector enables only the relevant fields and retains weekday choices", () => {
  const count = {}, unit = {}, start = {}, due = {}, days = [{checked:true}, {checked:false}];
  const recurring = {}, weekdays = {}, once = {};
  const nodes = { "[data-recurring]": recurring, "[data-weekdays]": weekdays, "[data-once]": once,
    '[name="startsOn"]': start, '[name="dueDate"]': due, '[name="intervalCount"]': count };
  const form = { querySelector: selector => nodes[selector], querySelectorAll: selector => selector === "[data-weekdays] input" ? days : [count,unit] };
  const selector = { value: "once", closest: () => form, addEventListener(event,fn) { this.change=fn; } };
  vm.runInNewContext(fs.readFileSync("src/public/app.js","utf8"), {
    location: { hash:"" }, window: { addEventListener() {} }, Intl, Date,
    document: { querySelectorAll: query => query === "[data-schedule]" ? [selector] : [] },
  });
  assert.equal(count.disabled,true);
  assert.equal(days[0].disabled,true);
  assert.equal(due.disabled,false);
  selector.value="weekdays"; selector.change();
  assert.equal(weekdays.hidden,false);
  assert.equal(recurring.hidden,true);
  assert.equal(start.required,true);
  assert.equal(count.disabled,true);
  assert.equal(count.required,false);
  assert.equal(due.disabled,true);
  assert.equal(days[0].disabled,false);
  selector.value="recurring"; selector.change();
  assert.equal(count.disabled,false);
  assert.equal(count.required,true);
  assert.equal(weekdays.hidden,true);
  assert.equal(days[0].disabled,true);
  selector.value="once"; selector.change();
  assert.equal(start.required,false);
  assert.equal(start.min,"");
  assert.equal(due.disabled,false);
  assert.equal(days[0].checked,true);
});
