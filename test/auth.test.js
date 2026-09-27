const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { createApp } = require('../src/server');

const password = 'test-password-only';
const passwordHash = bcrypt.hashSync(password, 4);

async function fixture(t, settings = {}) {
  let calls = 0;
  const db = {
    async query(sql, values) {
      calls += 1;
      if (sql.includes('password_hash')) {
        const username = values[0];
        return { rows: ['admin', 'member'].includes(username) ? [{
          id: username === 'admin' ? 1 : 2, username, display_name: username,
          role: username, password_hash: passwordHash
        }] : [] };
      }
      return { rows: [] };
    }
  };
  const env = { SESSION_SECRET: 'test-secret-only', SESSION_COOKIE_SECURE: 'false', ...settings };
  const server = createApp({ db, env }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    calls: () => calls,
    request: (path, options = {}) => fetch(base + path, { redirect: 'manual', ...options })
  };
}
function cookie(response) { return response.headers.get('set-cookie')?.split(';')[0]; }
function token(html) { return html.match(/name="_csrf" value="([^"]+)"/)[1]; }
function form(values, sessionCookie, headers = {}) {
  return { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded',
    ...(sessionCookie ? { Cookie: sessionCookie } : {}), ...headers }, body: new URLSearchParams(values) };
}

for (const role of ['admin', 'member']) {
  test(`HTTP ${role} login persists identity, rotates session/CSRF, and logout revokes access`, async (t) => {
    const f = await fixture(t);
    const page = await f.request('/login');
    const before = cookie(page);
    assert.ok(before);
    assert.match(page.headers.get('set-cookie'), /HttpOnly/);
    assert.match(page.headers.get('set-cookie'), /SameSite=Lax/);
    assert.doesNotMatch(page.headers.get('set-cookie'), /; Secure/);
    const csrf = token(await page.text());
    const login = await f.request('/login', form({ username: role, password, _csrf: csrf }, before));
    assert.equal(login.status, 302);
    assert.equal(login.headers.get('location'), '/');
    const after = cookie(login);
    assert.ok(after);
    assert.notEqual(after, before);
    const route = role === 'admin' ? '/admin' : '/profile';
    const home = await f.request('/', { headers: { Cookie: after } });
    assert.equal(home.headers.get('location'), route);
    const authenticated = await f.request(route, { headers: { Cookie: after } });
    assert.equal(authenticated.status, 200);
    const newCsrf = token(await authenticated.text());
    assert.notEqual(newCsrf, csrf);
    assert.notEqual((await f.request(route, { headers: { Cookie: before } })).status, 200);
    if (role === 'member') assert.equal((await f.request('/admin', { headers: { Cookie: after } })).status, 403);
    assert.equal((await f.request('/logout', form({ _csrf: csrf }, after))).status, 403);
    const logout = await f.request('/logout', form({ _csrf: newCsrf }, after));
    assert.equal(logout.status, 302);
    assert.match(logout.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
    assert.notEqual((await f.request(route, { headers: { Cookie: after } })).status, 200);
  });
}

test('HTTP login rejects missing/wrong/cross-session CSRF before querying credentials', async (t) => {
  const f = await fixture(t);
  const a = await f.request('/login');
  const aCookie = cookie(a); const aToken = token(await a.text());
  const b = await f.request('/login');
  const bToken = token(await b.text());
  for (const [csrf, sessionCookie] of [[undefined, aCookie], ['wrong', aCookie], [bToken, aCookie], [aToken, undefined]]) {
    const values = { username: 'admin', password };
    if (csrf) values._csrf = csrf;
    assert.equal((await f.request('/login', form(values, sessionCookie))).status, 403);
  }
  assert.equal(f.calls(), 0);
});

test('valid CSRF with incorrect credentials returns 401 and allows retry', async (t) => {
  const f = await fixture(t);
  const page = await f.request('/login'); const c = cookie(page); const csrf = token(await page.text());
  for (const [username, suppliedPassword] of [['missing', password], ['admin', 'wrong']]) {
    assert.equal((await f.request('/login', form({ username, password: suppliedPassword, _csrf: csrf }, c))).status, 401);
  }
  assert.equal((await f.request('/login', form({ username: 'admin', password, _csrf: csrf }, c))).status, 302);
});

test('secure default refuses HTTP cookies and ignores untrusted forwarded HTTPS', async (t) => {
  const f = await fixture(t, { SESSION_COOKIE_SECURE: undefined });
  for (const headers of [{}, { 'X-Forwarded-Proto': 'https' }]) {
    const page = await f.request('/login', { headers });
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('set-cookie'), null);
  }
});

test('explicitly trusted HTTPS proxy issues Secure cookies and supports login', async (t) => {
  const f = await fixture(t, { SESSION_COOKIE_SECURE: 'true', TRUST_PROXY: 'loopback' });
  const headers = { 'X-Forwarded-Proto': 'https' };
  const page = await f.request('/login', { headers });
  assert.match(page.headers.get('set-cookie'), /; Secure/);
  const c = cookie(page); const csrf = token(await page.text());
  const response = await f.request('/login', form({ username: 'admin', password, _csrf: csrf }, c, headers));
  assert.equal(response.status, 302);
  assert.match(response.headers.get('set-cookie'), /; Secure/);
});

test('invalid cookie mode fails startup instead of silently disabling Secure', () => {
  assert.throws(() => createApp({ env: { SESSION_COOKIE_SECURE: 'flase' } }), /must be true or false/);
});
