const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const { migrate } = require("../src/migrate");
const { createApp } = require("../src/server");
const { todayKey, formatDate } = require("../src/helpers");

test("quick chore assignments, permissions, rewards and filters", { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const root = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = "quick_chores_test_" + process.pid;
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
  async function post(body, auth=admin) {
    const form=new URLSearchParams({_csrf:auth.token});
    for(const [key,value] of Object.entries(body)) for(const entry of Array.isArray(value)?value:[value]) form.append(key,entry);
    return fetch(base+"/admin/quick-chores",{method:"POST",redirect:"manual",headers:{Cookie:auth.cookie,"Content-Type":"application/x-www-form-urlencoded"},body:form});
  }
  const body={title:"Quick kitchen cleanup",points:"7",memberIds:["2","3"]};
  const libraryCount=(await db.query("SELECT count(*) FROM chore_templates")).rows[0].count;
  for(const invalid of [{memberIds:[]},{memberIds:["999999"]},{title:""},{points:"-1"},{mode:"invalid"},{mode:"cooperative",memberIds:["2"]},{hasDeadline:"true"},{hasDeadline:"true",dueDate:"2026-02-30"},{hasDeadline:"true",dueDate:todayKey(),dueTime:"25:00"},{individualPoints:"true",memberPoints_2:"4"}])
    assert.equal((await post({...body,...invalid})).status,400);
  assert.equal((await post(body,member)).status,403);
  assert.equal((await db.query("SELECT * FROM chores")).rowCount,0);
  assert.equal((await post({...body,dueDate:"invalid",dueTime:"invalid",schedule:"recurring"})).status,302);
  const tasks=(await db.query("SELECT user_id,points,is_quick,template_id,due_date,series_id FROM chores ORDER BY user_id")).rows;
  assert.deepEqual(tasks,[2,3].map(user_id=>({user_id,points:7,is_quick:true,template_id:null,due_date:null,series_id:null})));
  assert.equal((await post({...body,mode:"cooperative",individualPoints:"true",memberPoints_2:"5",memberPoints_3:"13",hasDeadline:"true",dueDate:todayKey(),dueTime:"23:59"})).status,302);
  const shared=(await db.query("SELECT * FROM chores WHERE cooperative")).rows[0];
  assert.equal(shared.due_time,"23:59:00");
  assert.deepEqual((await db.query("SELECT user_id,points FROM chore_member_points WHERE chore_id=$1 ORDER BY user_id",[shared.id])).rows,[{user_id:2,points:5},{user_id:3,points:13}]);
  assert.equal((await db.query("SELECT count(*) FROM chore_templates")).rows[0].count,libraryCount);
  await db.query("INSERT INTO chores(title,user_id) VALUES('Regular library task',2)");
  async function page(query,auth=admin) { const r=await fetch(base+"/dashboard?"+query,{headers:{Cookie:auth.cookie}});assert.equal(r.status,200);return r.text(); }
  const overview=await page("section=overview");
  assert.match(overview,/data-quick-open/);assert.match(overview,/<dialog/);
  assert.doesNotMatch(await page("section=overview",member),/data-quick-open/);
  const quick=await page("section=chores&choreType=quick");
  assert.match(quick,/Quick kitchen cleanup/);assert.doesNotMatch(quick,/Regular library task/);
  const standard=await page("section=chores&choreType=standard");
  assert.doesNotMatch(standard,/Quick kitchen cleanup/);assert.match(standard,/Regular library task/);
  assert.match(await page("section=chores&choreType=quick&view=calendar"),/choreType=quick/);
  assert.match(await page("section=chores",member),/Quick Chore/);
  const response=await fetch(base+`/chores/${shared.id}/toggle`,{method:"POST",redirect:"manual",headers:{Cookie:member.cookie,"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({_csrf:member.token,completed:"true"})});
  assert.equal(response.status,302);
  assert.deepEqual((await db.query("SELECT user_id,amount FROM point_ledger WHERE chore_id=$1 ORDER BY user_id",[shared.id])).rows,[{user_id:2,amount:5},{user_id:3,amount:13}]);
});
