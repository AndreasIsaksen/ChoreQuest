const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Pool } = require('pg');
const { migrate } = require('../src/migrate');
const { todayKey } = require('../src/helpers');

test('points accounting, overdue processing and weekly settlement', { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const root = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = 'points_test_' + process.pid;
  await root.query(`CREATE SCHEMA ${schema}`);
  const db = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  t.after(async () => { await db.end(); await root.query(`DROP SCHEMA ${schema} CASCADE`); await root.end(); });
  await db.query(fs.readFileSync('db/init.sql', 'utf8'));
  await migrate(db);
  await migrate(db);
  const today = todayKey();
  const balances = async (user = 2) => (await db.query('SELECT weekly_points::text,permanent_points::text FROM member_points WHERE user_id=$1', [user])).rows[0];
  const chore = async (points, due = null, user = 2) => (await db.query('INSERT INTO chores(user_id,title,points,due_date) VALUES($1,\'Points test\',$2,$3) RETURNING id', [user, points, due])).rows[0].id;
  const clear = async () => { await db.query('TRUNCATE point_ledger,point_accounts'); await db.query('DELETE FROM chore_participants'); await db.query('DELETE FROM chores'); };

  await t.test('completion is idempotent, reopening reverses the award, and retrying cannot farm points', async () => {
    const id = await chore(12);
    await Promise.all([db.query('UPDATE chores SET completed=true WHERE id=$1', [id]), db.query('UPDATE chores SET completed=true WHERE id=$1', [id])]);
    assert.deepEqual(await balances(), { weekly_points: '12', permanent_points: '0' });
    await db.query('UPDATE chores SET completed=false WHERE id=$1', [id]);
    assert.equal((await balances()).weekly_points, '0');
    await db.query('UPDATE chores SET completed=true WHERE id=$1', [id]);
    assert.equal((await balances()).weekly_points, '12');
    await clear();
  });
  await t.test('no early penalties; Sunday debts transfer once at the Monday boundary', async () => {
    await chore(7, '2030-03-31');
    await db.query("SELECT process_points('2030-03-31')");
    assert.equal((await balances()).weekly_points, '0');
    await Promise.all([db.query("SELECT process_points('2030-04-01')"), db.query("SELECT process_points('2030-04-01')")]);
    assert.deepEqual(await balances(), { weekly_points: '0', permanent_points: '-7' });
    await db.query("SELECT process_points('2030-04-15')");
    assert.equal((await balances()).permanent_points, '-7');
    await clear();
  });
  await t.test('positive and negative balances settle and late historical entries go to permanent', async () => {
    const id = await chore(10);
    await db.query("SELECT post_points(2,$1,'completion',10,'2030-03-30','2030-03-30')", [id]);
    await db.query("SELECT post_points(3,$1,'overdue',-10,'2030-03-31','2030-03-31')", [id]);
    await db.query("SELECT process_points('2030-04-01')");
    assert.deepEqual(await balances(), { weekly_points: '0', permanent_points: '10' });
    assert.deepEqual(await balances(3), { weekly_points: '0', permanent_points: '-10' });
    await db.query("SELECT post_points(2,$1,'overdue',-10,'2030-03-31','2030-04-15')", [id]);
    assert.deepEqual(await balances(), { weekly_points: '0', permanent_points: '0' });
    await clear();
  });
  await t.test('late completion retains the penalty and grants the completion award', async () => {
    const id = await chore(9, '2020-01-05');
    await db.query('UPDATE chores SET completed=true WHERE id=$1', [id]);
    assert.deepEqual(await balances(), { weekly_points: '9', permanent_points: '-9' });
    await db.query('SELECT process_points($1::date)', [today]);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM point_ledger WHERE kind='overdue'")).rows[0].n, 1);
    await clear();
  });
  await t.test('co-op gives each participant the full amount, with shared reopen reversal', async () => {
    const id = await chore(15, null, null);
    await db.query('INSERT INTO chore_participants VALUES($1,2),($1,3)', [id]);
    await db.query('UPDATE chores SET completed=true WHERE id=$1', [id]);
    assert.equal((await balances()).weekly_points, '15');
    assert.equal((await balances(3)).weekly_points, '15');
    await db.query('UPDATE chores SET completed=false WHERE id=$1', [id]);
    assert.equal((await balances()).weekly_points, '0');
    assert.equal((await balances(3)).weekly_points, '0');
    await clear();
  });
  await t.test('unassigned and zero-point chores never change balances', async () => {
    await chore(10, '2020-01-01', null);
    await chore(0, '2020-01-01');
    await db.query('SELECT process_points($1::date)', [today]);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM point_ledger')).rows[0].n, 0);
    await clear();
  });
  await t.test('recurring downtime catch-up preserves points and charges every missed occurrence once', async () => {
    await db.query("INSERT INTO chore_series(title,user_id,points,starts_on,interval_count,interval_unit) VALUES('Daily',2,4,'2030-03-29',1,'days')");
    await db.query("SELECT generate_chore_occurrences('2030-04-01')");
    await db.query("SELECT process_points('2030-04-01')");
    assert.deepEqual(await balances(), { weekly_points: '0', permanent_points: '-12' });
    await db.query("SELECT generate_chore_occurrences('2030-04-01')");
    await db.query("SELECT process_points('2030-04-01')");
    assert.equal((await balances()).permanent_points, '-12');
  });
});
