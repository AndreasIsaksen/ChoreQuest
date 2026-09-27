CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chores (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due_date DATE NOT NULL,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chore_requests (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chore_id INT REFERENCES chores(id) ON DELETE SET NULL,
  request_type TEXT NOT NULL CHECK (request_type IN ('different_chore', 'due_date_change', 'other')),
  details TEXT NOT NULL,
  proposed_due_date DATE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  admin_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO users (username, display_name, role, password_hash)
VALUES
  ('admin', 'Admin User', 'admin', '$2b$10$7FO5eY95uXH6BzjWWNH12eQXQq9fXV4wOt93Hd5SxQucX9HY/Qtvu'),
  ('alex', 'Alex Member', 'member', '$2b$10$7FO5eY95uXH6BzjWWNH12eQXQq9fXV4wOt93Hd5SxQucX9HY/Qtvu'),
  ('sam', 'Sam Member', 'member', '$2b$10$7FO5eY95uXH6BzjWWNH12eQXQq9fXV4wOt93Hd5SxQucX9HY/Qtvu')
ON CONFLICT (username) DO NOTHING;
