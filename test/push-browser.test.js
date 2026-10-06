const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('src/public/push.js','utf8');
async function browser({permission='granted',existing=false,secure=true,configured=true}={}) {
  const calls=[];
  const button=()=>({hidden:false,disabled:false,addEventListener(event,handler){this.click=handler;}});
  const enable=button(), disable=button(), status={};
  const subscription={endpoint:'https://example.com/device',toJSON(){return {endpoint:this.endpoint,keys:{p256dh:'key',auth:'auth'}};},async unsubscribe(){calls.push({path:'browser-unsubscribe'});return true;}};
  const panel={dataset:{csrf:'csrf-token'},querySelector(selector){return {'[data-push-enable]':enable,'[data-push-disable]':disable,'[data-push-status]':status}[selector];}};
  const registration={pushManager:{async getSubscription(){return existing?subscription:null;},async subscribe(options){calls.push({path:'browser-subscribe',options});return subscription;}}};
  const Notification={permission,async requestPermission(){calls.push({path:'permission'});return permission;}};
  const context={document:{querySelector(){return panel;},documentElement:{lang:'en'}},window:{isSecureContext:secure,PushManager:{},Notification},Notification,navigator:{serviceWorker:{ready:Promise.resolve(registration),async register(path){calls.push({path});return registration;}}},Uint8Array,atob,async fetch(path,options){calls.push({path,options});return {ok:true,async json(){return {publicKey:configured?'AQID':null};}};}};
  await vm.runInNewContext(source,context);
  return {enable,disable,status,calls};
}
test('browser opt-in requires a click, sends CSRF, and opt-out removes both registrations',async()=>{
  const b=await browser();
  assert.ok(!b.calls.some(c=>c.path==='permission'));
  await b.enable.click();
  assert.equal(b.enable.hidden,true);
  assert.equal(b.disable.hidden,false);
  const post=b.calls.find(c=>c.path==='/api/push/subscribe');
  assert.equal(post.options.headers['X-CSRF-Token'],'csrf-token');
  assert.equal(JSON.parse(post.options.body).endpoint,'https://example.com/device');
  assert.equal(b.calls.find(c=>c.path==='browser-subscribe').options.userVisibleOnly,true);
  await b.disable.click();
  assert.equal(b.disable.hidden,true);
  assert.ok(b.calls.some(c=>c.path==='/api/push/unsubscribe'));
  assert.ok(b.calls.some(c=>c.path==='browser-unsubscribe'));
});
test('existing browser permission rebinds to the signed-in account without a prompt',async()=>{
  const b=await browser({existing:true});
  assert.ok(b.calls.some(c=>c.path==='/api/push/subscribe'));
  assert.ok(!b.calls.some(c=>c.path==='permission'));
});
test('denied, insecure and unconfigured browsers show actionable status',async()=>{
  const denied=await browser({permission:'denied'});
  await denied.enable.click();
  assert.match(denied.status.textContent,/browser settings/);
  assert.ok(!denied.calls.some(c=>c.path==='/api/push/subscribe'));
  const insecure=await browser({secure:false});
  assert.equal(insecure.enable.disabled,true);
  assert.match(insecure.status.textContent,/HTTPS/);
  const unconfigured=await browser({configured:false});
  assert.equal(unconfigured.enable.disabled,true);
  assert.match(unconfigured.status.textContent,/server/);
});
