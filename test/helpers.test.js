const test = require('node:test');
const assert = require('node:assert/strict');
const { filterChoresByMonth, groupChoresByDate } = require('../src/helpers');

test('filterChoresByMonth returns only chores in selected month', () => {
  const chores = [
    { id: 1, due_date: '2026-10-03' },
    { id: 2, due_date: '2026-10-27' },
    { id: 3, due_date: '2026-11-01' }
  ];

  assert.deepEqual(filterChoresByMonth(chores, '2026-10').map((c) => c.id), [1, 2]);
});

test('groupChoresByDate buckets chores by due date', () => {
  const grouped = groupChoresByDate([
    { id: 1, due_date: '2026-10-01' },
    { id: 2, due_date: '2026-10-01' },
    { id: 3, due_date: '2026-10-02' }
  ]);

  assert.equal(grouped['2026-10-01'].length, 2);
  assert.equal(grouped['2026-10-02'].length, 1);
});
