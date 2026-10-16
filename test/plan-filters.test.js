const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');
const { translator } = require('../src/i18n');

const filename = path.join(__dirname, '../src/views/partials/plan-filters.ejs');
const source = fs.readFileSync(filename, 'utf8');

test('filter links change one category, preserve the plan context and work without JavaScript', () => {
  for (const language of ['en', 'nb']) for (const isAdmin of [true, false]) for (const view of ['list', 'calendar']) {
    const current = { section: 'chores', view, month: '2027-02', member: isAdmin ? '3' : '', status: 'open', choreType: 'standard' };
    const html = ejs.render(source, {
      ...current, selectedMonth: current.month, isAdmin, t: translator(language),
      users: [{ id: 2, display_name: 'Alex' }, { id: 3, display_name: 'Sam <script>alert(1)</script>' }],
    }, { filename });
    assert.doesNotMatch(html, /<select|<script>/);
    const rows = [...html.matchAll(/<nav[^>]+aria-labelledby="filter-([^"]+)"[^>]*>([\s\S]*?)<\/nav>/g)];
    assert.deepEqual(rows.map(row => row[1]), isAdmin ? ['choreType', 'status', 'member'] : ['choreType', 'status']);
    for (const [, category, row] of rows) {
      const links = [...row.matchAll(/<a[^>]+href="([^"]+)"([^>]*)>/g)];
      assert.equal(links.filter(link => link[2].includes('aria-current="true"')).length, 1);
      for (const [, href, attributes] of links) {
        const url = new URL(href.replaceAll('&amp;', '&'), 'http://localhost');
        assert.equal(url.pathname, '/dashboard');
        assert.equal(url.hash, '#household-plan');
        for (const [key, value] of Object.entries(current)) {
          if (key !== category) assert.equal(url.searchParams.get(key), value);
        }
        assert.equal(attributes.includes('aria-current="true"'), url.searchParams.get(category) === current[category]);
      }
    }
    if (isAdmin) assert.match(html, /Sam &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    if (view === 'calendar') {
      assert.match(html, /type="month" name="month" value="2027-02" required/);
      for (const [key, value] of Object.entries(current)) if (key !== 'month')
        assert.ok(html.includes(`name="${key}" value="${value}"`));
      assert.match(html, /type="submit" data-filter-apply/);
    } else assert.doesNotMatch(html, /data-filter-month|data-filter-apply/);
  }
});

test('month changes apply immediately only when the date is valid', () => {
  const apply = { hidden: false };
  let valid = false, submissions = 0, change;
  const form = {
    querySelector: () => apply,
    reportValidity: () => valid,
    requestSubmit: () => submissions++,
    addEventListener(event, handler) { if (event === 'change') change = handler; },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/public/app.js'), 'utf8'), {
    location: { hash: '' }, window: { addEventListener() {} },
    document: { querySelectorAll: selector => selector === '[data-filter-month]' ? [form] : [] },
  });
  assert.equal(apply.hidden, true);
  change();
  assert.equal(submissions, 0);
  valid = true;
  change();
  assert.equal(submissions, 1);
});
