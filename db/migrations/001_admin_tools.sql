ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (lower(username));
ALTER TABLE chores ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE chores ALTER COLUMN due_date DROP NOT NULL;
ALTER TABLE chores ADD COLUMN IF NOT EXISTS window_start DATE;
ALTER TABLE chores ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS chore_series (
 id SERIAL PRIMARY KEY,
 title TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 user_id INTEGER REFERENCES users(id),
 starts_on DATE NOT NULL,
 interval_count INTEGER NOT NULL CHECK (interval_count BETWEEN 1 AND 365),
 interval_unit TEXT NOT NULL CHECK (interval_unit IN ('days','weeks','months')),
 active BOOLEAN NOT NULL DEFAULT TRUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE chores ADD COLUMN IF NOT EXISTS series_id INTEGER REFERENCES chore_series(id);
CREATE UNIQUE INDEX IF NOT EXISTS chores_series_window ON chores(series_id, window_start);
CREATE OR REPLACE FUNCTION generate_chore_occurrences(as_of DATE) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE s chore_series%ROWTYPE; n INTEGER; start_day DATE; next_day DATE; added INTEGER := 0; inserted INTEGER;
BEGIN
 PERFORM pg_advisory_xact_lock(718431);
 FOR s IN SELECT * FROM chore_series WHERE active AND starts_on <= as_of FOR UPDATE LOOP
  -- Always calculate month boundaries from the original anchor (Jan 31 -> Feb 28 -> Mar 31).
  SELECT count(*)::integer INTO n FROM chores WHERE series_id=s.id;
  LOOP
   start_day := (s.starts_on + make_interval(days => CASE s.interval_unit WHEN 'days' THEN n*s.interval_count WHEN 'weeks' THEN n*s.interval_count*7 ELSE 0 END, months => CASE WHEN s.interval_unit='months' THEN n*s.interval_count ELSE 0 END))::date;
   EXIT WHEN start_day > as_of;
   next_day := (s.starts_on + make_interval(days => CASE s.interval_unit WHEN 'days' THEN (n+1)*s.interval_count WHEN 'weeks' THEN (n+1)*s.interval_count*7 ELSE 0 END, months => CASE WHEN s.interval_unit='months' THEN (n+1)*s.interval_count ELSE 0 END))::date;
   INSERT INTO chores(user_id,title,description,window_start,due_date,series_id)
    VALUES(s.user_id,s.title,s.description,start_day,next_day-1,s.id)
    ON CONFLICT(series_id,window_start) DO NOTHING;
   GET DIAGNOSTICS inserted = ROW_COUNT;
   added := added + inserted; n := n+1;
  END LOOP;
 END LOOP;
 RETURN added;
END $$;
