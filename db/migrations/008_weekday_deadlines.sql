ALTER TABLE chore_series ADD COLUMN weekdays SMALLINT[];
ALTER TABLE chore_series ADD COLUMN due_time TIME;
ALTER TABLE chores ADD COLUMN due_time TIME;
ALTER TABLE chores ADD CONSTRAINT timed_chore_has_date CHECK (due_time IS NULL OR due_date IS NOT NULL);
ALTER TABLE chore_series ADD CONSTRAINT valid_weekdays CHECK (weekdays IS NULL OR (cardinality(weekdays) BETWEEN 1 AND 7 AND weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[] AND array_position(weekdays,NULL) IS NULL));

-- Date-only chores retain their deadline at the following midnight.
CREATE FUNCTION chore_deadline(day DATE, clock TIME) RETURNS TIMESTAMPTZ LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN clock IS NULL THEN (day+1)::timestamp ELSE day+clock END AT TIME ZONE 'Europe/Oslo';
$$;
-- Historical date callers retain midnight semantics; today's callers include the current time.
CREATE FUNCTION chore_as_of(day DATE) RETURNS TIMESTAMPTZ LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN day=(now() AT TIME ZONE 'Europe/Oslo')::date THEN now() ELSE day::timestamp AT TIME ZONE 'Europe/Oslo' END;
$$;

CREATE OR REPLACE FUNCTION penalize_chore(chore INTEGER, as_of DATE) RETURNS void LANGUAGE plpgsql AS $$
DECLARE task chores%ROWTYPE; person INTEGER;
BEGIN
 SELECT * INTO task FROM chores WHERE id=chore;
 IF task.removed_at IS NOT NULL OR task.points=0 OR task.due_date IS NULL OR chore_deadline(task.due_date,task.due_time)>chore_as_of(as_of) OR task.completed THEN RETURN; END IF;
 FOR person IN SELECT user_id FROM chore_members WHERE chore_id=chore LOOP
  -- A Sunday deadline belongs to the week ending that Sunday, even when processed Monday.
  PERFORM post_points(person,chore,'overdue',-task.points,task.due_date,as_of);
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION process_points(as_of DATE) RETURNS void LANGUAGE plpgsql AS $$
DECLARE task INTEGER;
BEGIN
 PERFORM pg_advisory_xact_lock(718431);
 FOR task IN SELECT id FROM chores WHERE removed_at IS NULL AND NOT completed AND chore_deadline(due_date,due_time)<=chore_as_of(as_of) AND points>0 ORDER BY id FOR UPDATE LOOP
  PERFORM penalize_chore(task,as_of);
 END LOOP;
 UPDATE point_accounts SET settled=true WHERE NOT settled AND week_start<date_trunc('week',as_of)::date;
END $$;


CREATE OR REPLACE FUNCTION generate_chore_occurrences(as_of DATE) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE s chore_series%ROWTYPE; n INTEGER; start_day DATE; next_day DATE; added INTEGER := 0; occurrence INTEGER;
BEGIN
 PERFORM pg_advisory_xact_lock(718431);
 FOR s IN SELECT * FROM chore_series WHERE active AND removed_at IS NULL AND starts_on <= as_of FOR UPDATE LOOP
  n := s.generated_count;
  LOOP
   IF s.weekdays IS NOT NULL THEN
    start_day := s.starts_on+n;
    next_day := start_day+1;
   ELSE
   start_day := (s.starts_on + make_interval(days => CASE s.interval_unit WHEN 'days' THEN n*s.interval_count WHEN 'weeks' THEN n*s.interval_count*7 ELSE 0 END, months => CASE WHEN s.interval_unit='months' THEN n*s.interval_count ELSE 0 END))::date;
   next_day := (s.starts_on + make_interval(days => CASE s.interval_unit WHEN 'days' THEN (n+1)*s.interval_count WHEN 'weeks' THEN (n+1)*s.interval_count*7 ELSE 0 END, months => CASE WHEN s.interval_unit='months' THEN (n+1)*s.interval_count ELSE 0 END))::date;
   END IF;
   EXIT WHEN start_day > as_of;
   IF s.weekdays IS NULL OR extract(isodow FROM start_day)::smallint=ANY(s.weekdays) THEN
   INSERT INTO chores(user_id,title,description,window_start,due_date,series_id,template_id,cooperative,points,due_time)
    VALUES(s.user_id,s.title,s.description,start_day,next_day-1,s.id,s.template_id,s.cooperative,s.points,s.due_time)
    ON CONFLICT(series_id,window_start) DO NOTHING RETURNING id INTO occurrence;
   IF occurrence IS NOT NULL THEN
    INSERT INTO chore_participants(chore_id,user_id) SELECT occurrence,user_id FROM series_participants WHERE series_id=s.id;
    added := added+1;
   END IF;
   END IF;
   n := n+1;
  END LOOP;
  UPDATE chore_series SET generated_count=n WHERE id=s.id;
 END LOOP;
 RETURN added;
END $$;
