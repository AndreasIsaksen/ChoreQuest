const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const { migrate } = require("../src/migrate");
const { createApp } = require("../src/server");
const { todayKey, formatDate } = require("../src/helpers");

test("individual member chore points", { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const root = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = "member_points_test_" + process.pid;
  await root.query(`CREATE SCHEMA ${schema}`);
  const db = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  t.after(async () => { await db.end(); await root.query(`DROP SCHEMA ${schema} CASCADE`); await root.end(); });
  await db.query(fs.readFileSync("db/init.sql", "utf8"));
  await migrate(db);
  await migrate(db);
  const password = "schedule-test-password";
  await db.query("UPDATE users SET password_hash=$1", [await bcrypt.hash(password, 4)]);
  const server = createApp({ db, env: { SESSION_SECRET: "schedule-test-secret", SESSION_COOKIE_SECURE: "false" } }).listen(0);
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = "http://127.0.0.1:" + server.address().port;
  const csrf = html => html.match(/name="_csrf" value="([^"]+)"/)[1];
  async function login(username) {
    let r = await fetch(base + "/login");
    let cookie = r.headers.get("set-cookie").split(";")[0];
    const token = csrf(await r.text());
    r = await fetch(base + "/login", { method: "POST", redirect: "manual", headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ username, password, _csrf: token }) });
    assert.equal(r.status, 302);
    cookie = r.headers.get("set-cookie").split(";")[0];
    const html = await (await fetch(base + "/dashboard", { headers: { Cookie: cookie } })).text();
    return { cookie, token: csrf(html) };
  }
  const admin = await login("admin"), member = await login("alex"), outsider = await login("sam");
  const template = (await db.query("INSERT INTO chore_templates(title,points) VALUES('Custom reward',0) RETURNING id")).rows[0].id;
  async function post(path, body, auth=admin) {
    const form = new URLSearchParams({ _csrf:auth.token });
    for (const [key,value] of Object.entries(body))
      for (const entry of Array.isArray(value)?value:[value]) form.append(key,entry);
    return fetch(base+path,{method:"POST",redirect:"manual",headers:{Cookie:auth.cookie,"Content-Type":"application/x-www-form-urlencoded"},body:form});
  }
  const assign = (body,auth) => post(`/admin/library/${template}/assign`,body,auth);
  const body={schedule:"once",memberIds:["2","3"],individualPoints:"true",memberPoints_2:"5",memberPoints_3:"13",points:"999"};
  for(const invalid of [{memberIds:[]},{memberPoints_2:""},{memberPoints_2:"-1"},{memberPoints_2:"1.5"},{memberPoints_2:"1000001"},{memberPoints_2:["1","2"]},{individualPoints:"false"},{memberIds:["999999"]}])
    assert.equal((await assign({...body,...invalid})).status,400);
  const missing={...body};delete missing.memberPoints_3;
  assert.equal((await assign(missing)).status,400);
  assert.equal((await assign(body,member)).status,403);
  assert.equal((await db.query("SELECT * FROM chores")).rowCount,0);
  assert.equal((await assign(body)).status,302);
  const tasks=(await db.query("SELECT user_id,points FROM chores ORDER BY user_id")).rows;
  assert.deepEqual(tasks,[{user_id:2,points:5},{user_id:3,points:13}]);
  assert.equal((await db.query("SELECT points FROM chore_templates WHERE id=$1",[template])).rows[0].points,0);
  const mine=(await db.query("SELECT id FROM chores WHERE user_id=2")).rows[0].id;
  assert.equal((await post(`/chores/${mine}/toggle`,{completed:"true"},member)).status,302);
  assert.equal((await db.query("SELECT amount FROM point_ledger WHERE chore_id=$1",[mine])).rows[0].amount,5);
  assert.equal((await assign({...body,mode:"cooperative"})).status,302);
  const shared=(await db.query("SELECT id FROM chores WHERE cooperative")).rows[0].id;
  assert.deepEqual((await db.query("SELECT user_id,points FROM chore_member_points WHERE chore_id=$1 ORDER BY user_id",[shared])).rows,[{user_id:2,points:5},{user_id:3,points:13}]);
  for(const [auth,value] of [[member,5],[outsider,13]]) {
    const html=await(await fetch(base+"/dashboard",{headers:{Cookie:auth.cookie}})).text();
    const card = html.slice(html.indexOf(`id="chore-${shared}"`) + 'id="chore-'.length).split('id="chore-')[0];
    assert.match(card, new RegExp(`class="badge pending">${value} points`));
  }
  assert.equal((await post(`/admin/chores/${shared}/assign`,{memberIds:["2","3"]})).status,302);
  assert.equal((await post(`/chores/${shared}/toggle`,{completed:"true"},member)).status,302);
  assert.equal((await post(`/chores/${shared}/toggle`,{completed:"true"},outsider)).status,302);
  assert.deepEqual((await db.query("SELECT user_id,amount FROM point_ledger WHERE chore_id=$1 ORDER BY user_id",[shared])).rows,[{user_id:2,amount:5},{user_id:3,amount:13}]);
  assert.equal((await post(`/chores/${shared}/toggle`,{completed:"false"},member)).status,302);
  assert.deepEqual((await db.query("SELECT user_id,sum(amount)::int AS total FROM point_ledger WHERE chore_id=$1 GROUP BY user_id ORDER BY user_id",[shared])).rows,[{user_id:2,total:0},{user_id:3,total:0}]);
  assert.equal((await post(`/admin/chores/${shared}/status`,{completed:"true"})).status,302);
  assert.deepEqual((await db.query("SELECT user_id,sum(amount)::int AS total FROM point_ledger WHERE chore_id=$1 GROUP BY user_id ORDER BY user_id",[shared])).rows,[{user_id:2,total:5},{user_id:3,total:13}]);
  const iso=String(new Date(todayKey()+"T12:00:00Z").getUTCDay()||7);
  for(const schedule of ["recurring","weekdays"]) {
    for(const mode of ["individual","cooperative"]) {
      const before=(await db.query("SELECT COALESCE(max(id),0) AS id FROM chore_series")).rows[0].id;
      assert.equal((await assign({...body,schedule,mode,startsOn:todayKey(),intervalCount:"1",intervalUnit:"days",weekdays:iso})).status,302);
      const series=(await db.query("SELECT * FROM chore_series WHERE id>$1 ORDER BY id",[before])).rows;
      assert.equal(series.length,mode==="individual"?2:1);
      if(mode==="individual")assert.deepEqual(series.map(s=>s.points),[5,13]);
      for(const s of series) {
        await post(`/admin/series/${s.id}`,{active:"false",...(mode==="cooperative"?{memberIds:["2","3"]}:{userId:String(s.user_id)})});
        await post(`/admin/series/${s.id}`,{active:"true",...(mode==="cooperative"?{memberIds:["2","3"]}:{userId:String(s.user_id)})});
      }
      await db.query("SELECT generate_chore_occurrences($1::date+7)",[todayKey()]);
      const rewards=(await db.query("SELECT DISTINCT m.user_id,m.points FROM chore_member_points m JOIN chores c ON c.id=m.chore_id WHERE c.series_id=ANY($1::int[]) ORDER BY m.user_id",[series.map(s=>s.id)])).rows;
      assert.deepEqual(rewards,[{user_id:2,points:5},{user_id:3,points:13}]);
    }
  }
  assert.equal((await assign({...body,mode:"cooperative",memberPoints_2:"0",memberPoints_3:"8"})).status,302);
  const zero=(await db.query("SELECT max(id) AS id FROM chores WHERE cooperative AND series_id IS NULL")).rows[0].id;
  await db.query("UPDATE chores SET due_date=$1::date-1 WHERE id=$2",[todayKey(),zero]);
  await db.query("SELECT process_points($1)",[todayKey()]);
  await db.query("SELECT process_points($1)",[todayKey()]);
  assert.deepEqual((await db.query("SELECT user_id,amount FROM point_ledger WHERE chore_id=$1",[zero])).rows,[{user_id:3,amount:-8}]);
  await post(`/admin/chores/${zero}/status`,{completed:"true"});
  assert.deepEqual((await db.query("SELECT user_id,sum(amount)::int AS total FROM point_ledger WHERE chore_id=$1 GROUP BY user_id",[zero])).rows,[{user_id:3,total:8}]);
  await post(`/admin/chores/${zero}/status`,{completed:"false"});
  assert.deepEqual((await db.query("SELECT user_id,sum(amount)::int AS total FROM point_ledger WHERE chore_id=$1 GROUP BY user_id",[zero])).rows,[{user_id:3,total:-8}]);
  assert.equal((await assign({schedule:"once",memberIds:["2","3"],points:"21",memberPoints_2:"bad"})).status,302);
  assert.equal((await db.query("SELECT points FROM chore_templates WHERE id=$1",[template])).rows[0].points,21);
  assert.deepEqual((await db.query("SELECT points FROM chores WHERE points=21")).rows.map(row=>row.points),[21,21]);
});
