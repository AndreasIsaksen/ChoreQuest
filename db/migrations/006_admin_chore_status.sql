ALTER TABLE point_ledger DROP CONSTRAINT point_ledger_kind_check;
ALTER TABLE point_ledger ADD CHECK(kind IN ('completion','reopen','overdue','admin_adjustment','admin_status'));

-- Reopening through either interface also reverses administrator compensation.
CREATE OR REPLACE FUNCTION chore_points_change() RETURNS trigger LANGUAGE plpgsql AS $$
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
    WHERE chore_id=OLD.id AND kind IN ('completion','reopen','admin_status') GROUP BY user_id HAVING sum(amount)<>0 LOOP
    PERFORM post_points(person.user_id,OLD.id,'reopen',-person.awarded,as_of,as_of);
   END LOOP;
  END IF;
 END IF;
 RETURN NEW;
END $$;

-- Called inside the administration transaction after missed deadlines are processed.
-- Historical debts stay in the bank; their compensation is posted to this week.
CREATE FUNCTION set_admin_chore_status(chore INTEGER, done BOOLEAN, actor INTEGER, as_of DATE) RETURNS void LANGUAGE plpgsql AS $$
DECLARE task chores%ROWTYPE; person RECORD; target INTEGER; correction INTEGER;
BEGIN
 SELECT * INTO task FROM chores WHERE id=chore FOR UPDATE;
 UPDATE chores SET completed=done,
  completed_at=CASE WHEN done THEN COALESCE(completed_at,now()) ELSE NULL END WHERE id=chore;
 -- A completed chore reopened after its deadline needs its first penalty now.
 PERFORM penalize_chore(chore,as_of);
 FOR person IN
  SELECT m.user_id, COALESCE(sum(l.amount),0)::integer AS total,
   COALESCE(sum(l.amount) FILTER (WHERE l.kind='overdue'),0)::integer AS penalty
  FROM chore_members m LEFT JOIN point_ledger l ON l.chore_id=m.chore_id AND l.user_id=m.user_id
  WHERE m.chore_id=chore GROUP BY m.user_id
 LOOP
  target := CASE WHEN done THEN task.points ELSE person.penalty END;
  correction := target-person.total;
  IF correction<>0 THEN
   PERFORM post_points(person.user_id,chore,'admin_status',correction,as_of,as_of);
   UPDATE point_ledger SET actor_id=actor WHERE id=currval(pg_get_serial_sequence('point_ledger','id'));
  END IF;
 END LOOP;
END $$;
