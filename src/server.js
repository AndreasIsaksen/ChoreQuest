require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
const pool = require('./db');
const { filterChoresByMonth, groupChoresByDate } = require('./helpers');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: false }));
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 250,
    standardHeaders: true,
    legacyHeaders: false
  })
);
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'local-dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: true
    }
  })
);
app.use((req, res, next) => {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;
  next();
});
app.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  if (req.body._csrf === req.session.csrfToken || req.headers['x-csrf-token'] === req.session.csrfToken) {
    return next();
  }
  return res.status(403).send('Invalid CSRF token');
});

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).send('Forbidden');
  next();
}

app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  return req.session.user.role === 'admin' ? res.redirect('/admin') : res.redirect('/profile');
});

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  return res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const result = await pool.query(
    'SELECT id, username, display_name, role, password_hash FROM users WHERE username = $1',
    [username]
  );

  if (!result.rows[0]) return res.status(401).render('login', { error: 'Invalid username or password' });

  const user = result.rows[0];
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).render('login', { error: 'Invalid username or password' });

  req.session.user = {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role
  };

  return res.redirect('/');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/profile', requireAuth, async (req, res) => {
  if (req.session.user.role === 'admin') return res.redirect('/admin');

  const selectedMonth = req.query.month || '';
  const choresResult = await pool.query(
    'SELECT id, title, description, due_date, completed FROM chores WHERE user_id = $1 ORDER BY due_date ASC',
    [req.session.user.id]
  );
  const memberChores = filterChoresByMonth(choresResult.rows, selectedMonth);

  const requestsResult = await pool.query(
    'SELECT id, request_type, details, proposed_due_date, status, admin_note, created_at FROM chore_requests WHERE user_id = $1 ORDER BY created_at DESC',
    [req.session.user.id]
  );

  return res.render('profile', {
    user: req.session.user,
    chores: memberChores,
    choresByDate: groupChoresByDate(memberChores),
    requests: requestsResult.rows,
    selectedMonth
  });
});

app.post('/chores/:id/toggle', requireAuth, async (req, res) => {
  await pool.query(
    'UPDATE chores SET completed = NOT completed WHERE id = $1 AND user_id = $2',
    [req.params.id, req.session.user.id]
  );
  return res.redirect('/profile');
});

app.post('/requests', requireAuth, async (req, res) => {
  const { choreId, requestType, details, proposedDueDate } = req.body;
  await pool.query(
    `INSERT INTO chore_requests (user_id, chore_id, request_type, details, proposed_due_date)
     VALUES ($1, NULLIF($2, '')::INT, $3, $4, NULLIF($5, '')::DATE)`,
    [req.session.user.id, choreId || '', requestType, details, proposedDueDate || '']
  );
  return res.redirect('/profile');
});

app.get('/admin', requireAdmin, async (req, res) => {
  const users = await pool.query('SELECT id, username, display_name, role FROM users ORDER BY role DESC, display_name ASC');
  const chores = await pool.query(
    'SELECT c.id, c.title, c.description, c.due_date, c.completed, u.display_name FROM chores c JOIN users u ON u.id = c.user_id ORDER BY c.due_date ASC'
  );
  const requests = await pool.query(
    'SELECT r.id, r.user_id, r.chore_id, r.request_type, r.details, r.proposed_due_date, r.status, r.admin_note, r.created_at, u.display_name FROM chore_requests r JOIN users u ON u.id = r.user_id ORDER BY r.created_at DESC'
  );

  return res.render('admin', {
    user: req.session.user,
    users: users.rows.filter((u) => u.role === 'member'),
    chores: chores.rows,
    requests: requests.rows
  });
});

app.post('/admin/chores', requireAdmin, async (req, res) => {
  const { userId, title, description, dueDate } = req.body;
  await pool.query(
    'INSERT INTO chores (user_id, title, description, due_date) VALUES ($1, $2, $3, $4)',
    [userId, title, description || '', dueDate]
  );
  return res.redirect('/admin');
});

app.post('/admin/requests/:id', requireAdmin, async (req, res) => {
  const { status, adminNote, approvedDueDate } = req.body;

  const requestResult = await pool.query(
    'UPDATE chore_requests SET status = $1, admin_note = $2 WHERE id = $3 RETURNING chore_id',
    [status, adminNote || null, req.params.id]
  );

  if (status === 'approved' && approvedDueDate && requestResult.rows[0]?.chore_id) {
    await pool.query('UPDATE chores SET due_date = $1 WHERE id = $2', [
      approvedDueDate,
      requestResult.rows[0].chore_id
    ]);
  }

  return res.redirect('/admin');
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Unexpected server error');
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`ChoreQuest running on port ${port}`);
});
