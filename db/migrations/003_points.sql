ALTER TABLE chore_templates ADD COLUMN points INTEGER NOT NULL DEFAULT 0 CHECK (points BETWEEN 0 AND 1000000);
ALTER TABLE chore_series ADD COLUMN points INTEGER NOT NULL DEFAULT 0 CHECK (points BETWEEN 0 AND 1000000);
ALTER TABLE chores ADD COLUMN points INTEGER NOT NULL DEFAULT 0 CHECK (points BETWEEN 0 AND 1000000);

-- Weekly buckets are retained after transfer for an auditable history.
CREATE TABLE point_accounts (
 user_id INTEGER NOT NULL REFERENCES users(id),
 week_start DATE NOT NULL,
 balance BIGINT NOT NULL DEFAULT 0,
 settled BOOLEAN NOT NULL DEFAULT false,
 PRIMARY KEY(user_id,week_start)
);
CREATE TABLE point_ledger (
 id BIGSERIAL PRIMARY KEY,
 user_id INTEGER NOT NULL REFERENCES users(id),
 chore_id INTEGER NOT NULL REFERENCES chores(id),
 kind TEXT NOT NULL CHECK(kind IN ('completion','reopen','overdue')),
 amount INTEGER NOT NULL,
 week_start DATE NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX point_overdue_once ON point_ledger(chore_id,user_id) WHERE kind='overdue';
CREATE INDEX point_ledger_chore ON point_ledger(chore_id);
CREATE VIEW member_points AS
 SELECT u.id AS user_id,
 COALESCE(sum(a.balance) FILTER(WHERE NOT a.settled),0) AS weekly_points,
 COALESCE(sum(a.balance) FILTER(WHERE a.settled),0) AS permanent_points
 FROM users u LEFT JOIN point_accounts a ON a.user_id=u.id GROUP BY u.id;

CREATE FUNCTION post_points(person INTEGER, chore INTEGER, reason TEXT, amount INTEGER, earned_on DATE, as_of DATE) RETURNS void LANGUAGE plpgsql AS $$
DECLARE week DATE := date_trunc('week',earned_on)::date; inserted BIGINT;
BEGIN
 IF amount=0 THEN RETURN; END IF;
 INSERT INTO point_ledger(user_id,chore_id,kind,amount,week_start)
 VALUES(person,chore,reason,amount,week) ON CONFLICT DO NOTHING RETURNING id INTO inserted;
 IF inserted IS NULL THEN RETURN; END IF;
 INSERT INTO point_accounts(user_id,week_start,balance,settled)
 VALUES(person,week,amount,week < date_trunc('week',as_of)::date)
 ON CONFLICT(user_id,week_start) DO UPDATE SET balance=point_accounts.balance+EXCLUDED.balance,
 settled=point_accounts.settled OR EXCLUDED.settled;
END $$;

CREATE FUNCTION penalize_chore(chore INTEGER, as_of DATE) RETURNS void LANGUAGE plpgsql AS $$
DECLARE task chores%ROWTYPE; person INTEGER;
BEGIN
 SELECT * INTO task FROM chores WHERE id=chore;
 IF task.points=0 OR task.due_date IS NULL OR task.due_date>=as_of OR task.completed THEN RETURN; END IF;
 FOR person IN SELECT user_id FROM chore_members WHERE chore_id=chore LOOP
  -- A Sunday deadline belongs to the week ending that Sunday, even when processed Monday.
  PERFORM post_points(person,chore,'overdue',-task.points,task.due_date,as_of);
 END LOOP;
END $$;

CREATE FUNCTION process_points(as_of DATE) RETURNS void LANGUAGE plpgsql AS $$
DECLARE task INTEGER;
BEGIN
 PERFORM pg_advisory_xact_lock(718431);
 FOR task IN SELECT id FROM chores WHERE NOT completed AND due_date<as_of AND points>0 ORDER BY id FOR UPDATE LOOP
  PERFORM penalize_chore(task,as_of);
 END LOOP;
 UPDATE point_accounts SET settled=true WHERE NOT settled AND week_start<date_trunc('week',as_of)::date;
END $$;

CREATE FUNCTION chore_points_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE as_of DATE := (now() AT TIME ZONE 'Europe/Oslo')::date; person RECORD;
BEGIN
 -- Capture missed deadlines before completion, reassignment or deadline edits.
 PERFORM penalize_chore(OLD.id,as_of);
 IF NEW.completed IS DISTINCT FROM OLD.completed THEN
  IF NEW.completed THEN
   FOR person IN SELECT user_id FROM chore_members WHERE chore_id=OLD.id LOOP
    PERFORM post_points(person.user_id,OLD.id,'completion',OLD.points,as_of,as_of);
   END LOOP;
  ELSE
   FOR person IN SELECT user_id,sum(amount)::integer AS awarded FROM point_ledger
    WHERE chore_id=OLD.id AND kind IN ('completion','reopen') GROUP BY user_id HAVING sum(amount)<>0 LOOP
    PERFORM post_points(person.user_id,OLD.id,'reopen',-person.awarded,as_of,as_of);
   END LOOP;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER chore_points_change BEFORE UPDATE ON chores FOR EACH ROW EXECUTE FUNCTION chore_points_change();

CREATE OR REPLACE FUNCTION generate_chore_occurrences(as_of DATE) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE s chore_series%ROWTYPE; n INTEGER; start_day DATE; next_day DATE; added INTEGER := 0; occurrence INTEGER;
BEGIN
 PERFORM pg_advisory_xact_lock(718431);
 FOR s IN SELECT * FROM chore_series WHERE active AND starts_on <= as_of FOR UPDATE LOOP
  SELECT count(*)::integer INTO n FROM chores WHERE series_id=s.id;
  LOOP
   start_day := (s.starts_on + make_interval(days => CASE s.interval_unit WHEN 'days' THEN n*s.interval_count WHEN 'weeks' THEN n*s.interval_count*7 ELSE 0 END, months => CASE WHEN s.interval_unit='months' THEN n*s.interval_count ELSE 0 END))::date;
   EXIT WHEN start_day > as_of;
   next_day := (s.starts_on + make_interval(days => CASE s.interval_unit WHEN 'days' THEN (n+1)*s.interval_count WHEN 'weeks' THEN (n+1)*s.interval_count*7 ELSE 0 END, months => CASE WHEN s.interval_unit='months' THEN (n+1)*s.interval_count ELSE 0 END))::date;
   INSERT INTO chores(user_id,title,description,window_start,due_date,series_id,template_id,cooperative,points)
    VALUES(s.user_id,s.title,s.description,start_day,next_day-1,s.id,s.template_id,s.cooperative,s.points)
    ON CONFLICT(series_id,window_start) DO NOTHING RETURNING id INTO occurrence;
   IF occurrence IS NOT NULL THEN
    INSERT INTO chore_participants(chore_id,user_id) SELECT occurrence,user_id FROM series_participants WHERE series_id=s.id;
    added := added+1;
   END IF;
   n := n+1;
  END LOOP;
 END LOOP;
 RETURN added;
END $$;
