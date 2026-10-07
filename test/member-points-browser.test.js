const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

test("individual points replace the shared input only for selected members", () => {
  const shared = {value:"10"}, sharedField = {};
  const members = [true,false].map(checked => {
    const choice = {checked}, input = {value:"10"};
    const field = {querySelector:()=>input};
    return {choice,input,field,querySelector:query=>query==="[data-member-select]"?choice:field};
  });
  const form = {querySelector:query=>query==="[data-shared-points]"?sharedField:shared,
    querySelectorAll:()=>members, addEventListener(event,fn) {this.change=fn;}};
  const toggle = {checked:false,closest:()=>form};
  vm.runInNewContext(fs.readFileSync("src/public/app.js","utf8"), {
    location:{hash:""},window:{addEventListener(){}},
    document:{querySelectorAll:query=>query==="[data-individual-points]"?[toggle]:[]},
  });
  assert.equal(shared.disabled,false);
  assert.equal(shared.required,true);
  assert.ok(members.every(member=>member.input.disabled && member.field.hidden));
  toggle.checked=true;form.change();
  assert.equal(sharedField.hidden,true);
  assert.equal(shared.disabled,true);
  assert.equal(shared.required,false);
  assert.equal(members[0].field.hidden,false);
  assert.equal(members[0].input.required,true);
  assert.equal(members[1].input.disabled,true);
  members[0].input.value="7";
  members[0].choice.checked=false;members[1].choice.checked=true;form.change();
  assert.equal(members[0].input.required,false);
  assert.equal(members[0].input.disabled,true);
  assert.equal(members[1].field.hidden,false);
  toggle.checked=false;form.change();
  assert.equal(sharedField.hidden,false);
  assert.equal(shared.value,"10");
  assert.equal(members[0].input.value,"7");
  assert.ok(members.every(member=>member.input.disabled));
});
