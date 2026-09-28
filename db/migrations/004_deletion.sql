ALTER TABLE chore_templates ADD COLUMN removed_at TIMESTAMPTZ;
ALTER TABLE chore_series ADD COLUMN removed_at TIMESTAMPTZ;
ALTER TABLE chores ADD COLUMN removed_at TIMESTAMPTZ;
-- Freeze historical visibility at removal: cancelled tasks must not become overdue later.
ALTER TABLE chores ADD COLUMN removed_history BOOLEAN NOT NULL DEFAULT false;

-- Account deletion erases attributed data, while other members retain their points.
ALTER TABLE chore_series DROP CONSTRAINT chore_series_user_id_fkey;
ALTER TABLE chore_series ADD FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE chores DROP CONSTRAINT chores_series_id_fkey;
ALTER TABLE chores ADD FOREIGN KEY(series_id) REFERENCES chore_series(id) ON DELETE SET NULL;
ALTER TABLE chore_participants DROP CONSTRAINT chore_participants_user_id_fkey;
ALTER TABLE chore_participants ADD FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE series_participants DROP CONSTRAINT series_participants_user_id_fkey;
ALTER TABLE series_participants ADD FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE point_accounts DROP CONSTRAINT point_accounts_user_id_fkey;
ALTER TABLE point_accounts ADD FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE point_ledger DROP CONSTRAINT point_ledger_user_id_fkey;
ALTER TABLE point_ledger ADD FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE point_ledger DROP CONSTRAINT point_ledger_chore_id_fkey;
ALTER TABLE point_ledger ALTER COLUMN chore_id DROP NOT NULL;
ALTER TABLE point_ledger ADD FOREIGN KEY(chore_id) REFERENCES chores(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION penalize_chore(chore INTEGER, as_of DATE) RETURNS void LANGUAGE plpgsql AS $$
DECLARE task chores%ROWTYPE; person INTEGER;
BEGIN
 SELECT * INTO task FROM chores WHERE id=chore;
 IF task.removed_at IS NOT NULL OR task.points=0 OR task.due_date IS NULL OR task.due_date>=as_of OR task.completed THEN RETURN; END IF;
 FOR person IN SELECT user_id FROM chore_members WHERE chore_id=chore LOOP
  -- A Sunday deadline belongs to the week ending that Sunday, even when processed Monday.
  PERFORM post_points(person,chore,'overdue',-task.points,task.due_date,as_of);
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION process_points(as_of DATE) RETURNS void LANGUAGE plpgsql AS $$
DECLARE task INTEGER;
BEGIN
 PERFORM pg_advisory_xact_lock(718431);
 FOR task IN SELECT id FROM chores WHERE removed_at IS NULL AND NOT completed AND due_date<as_of AND points>0 ORDER BY id FOR UPDATE LOOP
  PERFORM penalize_chore(task,as_of);
 END LOOP;
 UPDATE point_accounts SET settled=true WHERE NOT settled AND week_start<date_trunc('week',as_of)::date;
END $$;


-- Keep a generation cursor independent of rows purged by permanent account deletion.
ALTER TABLE chore_series ADD COLUMN generated_count INTEGER NOT NULL DEFAULT 0;
UPDATE chore_series s SET generated_count=(SELECT count(*) FROM chores c WHERE c.series_id=s.id);
CREATE OR REPLACE FUNCTION generate_chore_occurrences(as_of DATE) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE s chore_series%ROWTYPE; n INTEGER; start_day DATE; next_day DATE; added INTEGER := 0; occurrence INTEGER;
BEGIN
 PERFORM pg_advisory_xact_lock(718431);
 FOR s IN SELECT * FROM chore_series WHERE active AND removed_at IS NULL AND starts_on <= as_of FOR UPDATE LOOP
  n := s.generated_count;
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
  UPDATE chore_series SET generated_count=n WHERE id=s.id;
 END LOOP;
 RETURN added;
END $$;
