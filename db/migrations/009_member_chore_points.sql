ALTER TABLE chore_participants ADD COLUMN points INTEGER CHECK (points BETWEEN 0 AND 1000000);
ALTER TABLE series_participants ADD COLUMN points INTEGER CHECK (points BETWEEN 0 AND 1000000);

-- Null overrides keep the original shared value, including for existing assignments.
CREATE VIEW chore_member_points AS
 SELECT m.chore_id,m.user_id,COALESCE(p.points,c.points) AS points
 FROM chore_members m JOIN chores c ON c.id=m.chore_id
 LEFT JOIN chore_participants p ON p.chore_id=m.chore_id AND p.user_id=m.user_id;

CREATE OR REPLACE FUNCTION penalize_chore(chore INTEGER, as_of DATE) RETURNS void LANGUAGE plpgsql AS $$
DECLARE task chores%ROWTYPE; person RECORD;
BEGIN
 SELECT * INTO task FROM chores WHERE id=chore;
 IF task.removed_at IS NOT NULL OR task.due_date IS NULL OR chore_deadline(task.due_date,task.due_time)>chore_as_of(as_of) OR task.completed THEN RETURN; END IF;
 FOR person IN SELECT user_id,points FROM chore_member_points WHERE chore_id=chore LOOP
  -- A Sunday deadline belongs to the week ending that Sunday, even when processed Monday.
  PERFORM post_points(person.user_id,chore,'overdue',-person.points,task.due_date,as_of);
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION process_points(as_of DATE) RETURNS void LANGUAGE plpgsql AS $$
DECLARE task INTEGER;
BEGIN
 PERFORM pg_advisory_xact_lock(718431);
 FOR task IN SELECT id FROM chores WHERE removed_at IS NULL AND NOT completed AND chore_deadline(due_date,due_time)<=chore_as_of(as_of) AND EXISTS (SELECT 1 FROM chore_member_points m WHERE m.chore_id=chores.id AND m.points>0) ORDER BY id FOR UPDATE LOOP
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
    INSERT INTO chore_participants(chore_id,user_id,points) SELECT occurrence,user_id,points FROM series_participants WHERE series_id=s.id;
    added := added+1;
   END IF;
   END IF;
   n := n+1;
  END LOOP;
  UPDATE chore_series SET generated_count=n WHERE id=s.id;
 END LOOP;
 RETURN added;
END $$;

CREATE OR REPLACE FUNCTION chore_points_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE as_of DATE := (now() AT TIME ZONE 'Europe/Oslo')::date; person RECORD;
BEGIN
 -- Capture missed deadlines before completion, reassignment or deadline edits.
 PERFORM penalize_chore(OLD.id,as_of);
 IF NEW.completed IS DISTINCT FROM OLD.completed THEN
  IF NEW.completed THEN
   FOR person IN SELECT user_id,points FROM chore_member_points WHERE chore_id=OLD.id LOOP
    PERFORM post_points(person.user_id,OLD.id,'completion',person.points,as_of,as_of);
   END LOOP;
  ELSE
   FOR person IN SELECT user_id,sum(amount)::integer AS awarded FROM point_ledger
    WHERE chore_id=OLD.id AND kind IN ('completion','reopen','admin_status') GROUP BY user_id HAVING sum(amount)<>0 LOOP
    PERFORM post_points(person.user_id,OLD.id,'reopen',-person.awarded,as_of,as_of);
   END LOOP;
  END IF;
 END IF;
 RETURN NEW;
END $$;

-- Called inside the administration transaction after missed deadlines are processed.
-- Historical debts stay in the bank; their compensation is posted to this week.
CREATE OR REPLACE FUNCTION set_admin_chore_status(chore INTEGER, done BOOLEAN, actor INTEGER, as_of DATE) RETURNS void LANGUAGE plpgsql AS $$
DECLARE task chores%ROWTYPE; person RECORD; target INTEGER; correction INTEGER;
BEGIN
 SELECT * INTO task FROM chores WHERE id=chore FOR UPDATE;
 UPDATE chores SET completed=done,
  completed_at=CASE WHEN done THEN COALESCE(completed_at,now()) ELSE NULL END WHERE id=chore;
 -- A completed chore reopened after its deadline needs its first penalty now.
 PERFORM penalize_chore(chore,as_of);
 FOR person IN
  SELECT m.user_id,m.points, COALESCE(sum(l.amount),0)::integer AS total,
   COALESCE(sum(l.amount) FILTER (WHERE l.kind='overdue'),0)::integer AS penalty
  FROM chore_member_points m LEFT JOIN point_ledger l ON l.chore_id=m.chore_id AND l.user_id=m.user_id
  WHERE m.chore_id=chore GROUP BY m.user_id,m.points
 LOOP
  target := CASE WHEN done THEN person.points ELSE person.penalty END;
  correction := target-person.total;
  IF correction<>0 THEN
   PERFORM post_points(person.user_id,chore,'admin_status',correction,as_of,as_of);
   UPDATE point_ledger SET actor_id=actor WHERE id=currval(pg_get_serial_sequence('point_ledger','id'));
  END IF;
 END LOOP;
END $$;
