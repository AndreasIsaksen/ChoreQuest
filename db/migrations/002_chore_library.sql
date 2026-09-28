CREATE TABLE chore_templates (
 id SERIAL PRIMARY KEY,
 title TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO chore_templates(title,description)
 SELECT title,description FROM chores UNION SELECT title,description FROM chore_series;
ALTER TABLE chores ADD COLUMN template_id INTEGER REFERENCES chore_templates(id);
ALTER TABLE chore_series ADD COLUMN template_id INTEGER REFERENCES chore_templates(id);
UPDATE chores c SET template_id=t.id FROM chore_templates t WHERE c.title=t.title AND c.description=t.description;
UPDATE chore_series s SET template_id=t.id FROM chore_templates t WHERE s.title=t.title AND s.description=t.description;
ALTER TABLE chores ADD COLUMN cooperative BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE chore_series ADD COLUMN cooperative BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE chore_participants (
 chore_id INTEGER NOT NULL REFERENCES chores(id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL REFERENCES users(id),
 PRIMARY KEY(chore_id,user_id)
);
CREATE TABLE series_participants (
 series_id INTEGER NOT NULL REFERENCES chore_series(id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL REFERENCES users(id),
 PRIMARY KEY(series_id,user_id)
);
CREATE VIEW chore_members AS
 SELECT id AS chore_id,user_id FROM chores WHERE user_id IS NOT NULL
 UNION SELECT chore_id,user_id FROM chore_participants;
CREATE VIEW series_members AS
 SELECT id AS series_id,user_id FROM chore_series WHERE user_id IS NOT NULL
 UNION SELECT series_id,user_id FROM series_participants;
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
   INSERT INTO chores(user_id,title,description,window_start,due_date,series_id,template_id,cooperative)
    VALUES(s.user_id,s.title,s.description,start_day,next_day-1,s.id,s.template_id,s.cooperative)
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
