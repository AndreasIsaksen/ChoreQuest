const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('src/public/theme.js', 'utf8');
function browser(saved, blocked = false) {
  const events = {}, attributes = {};
  const button = { dataset: { lightLabel: 'Light', darkLabel: 'Dark' },
    setAttribute(key, value) { attributes[key] = value; },
    addEventListener(event, handler) { this[event] = handler; } };
  const root = { dataset: {} };
  const storage = { getItem() { if (blocked) throw Error(); return saved; },
    setItem(key, value) { if (blocked) throw Error(); saved = value; } };
  vm.runInNewContext(source, { document: { documentElement: root,
    querySelectorAll: () => [button], addEventListener(event, handler) { events[event] = handler; } },
    window: { addEventListener(event, handler) { events[event] = handler; } }, localStorage: storage });
  events.DOMContentLoaded();
  return { root, button, events, attributes, saved: () => saved };
}
test('theme initializes before content, toggles both ways and restores preference', () => {
  const b = browser();
  assert.equal(b.root.dataset.theme, 'light');
  assert.equal(b.attributes['aria-label'], 'Dark');
  b.button.click();
  assert.equal(b.root.dataset.theme, 'dark');
  assert.equal(b.button.title, 'Light');
  assert.equal(browser(b.saved()).root.dataset.theme, 'dark');
  b.button.click();
  assert.equal(b.root.dataset.theme, 'light');
  assert.equal(b.saved(), 'light');
});
test('storage failure still allows toggling; changed and cleared preferences sync tabs', () => {
  const b = browser('dark', true);
  b.button.click();
  assert.equal(b.root.dataset.theme, 'dark');
  b.events.storage({ key: 'chorequest_theme', newValue: 'light' });
  assert.equal(b.root.dataset.theme, 'light');
  b.events.storage({ key: 'chorequest_theme', newValue: 'dark' });
  assert.equal(b.root.dataset.theme, 'dark');
  b.events.storage({ key: null, newValue: null });
  assert.equal(b.root.dataset.theme, 'light');
});
