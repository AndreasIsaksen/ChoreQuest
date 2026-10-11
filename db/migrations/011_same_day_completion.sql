-- A timed deadline can be overdue while member completion remains open until
-- midnight at the end of that date in the household's timezone.
CREATE FUNCTION member_chore_completion_open(due_day DATE, instant TIMESTAMPTZ) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
 SELECT due_day IS NULL OR (instant AT TIME ZONE 'Europe/Oslo')::date <= due_day;
$$;

CREATE OR REPLACE FUNCTION chore_points_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE as_of DATE := (now() AT TIME ZONE 'Europe/Oslo')::date; person RECORD; deduction INTEGER;
BEGIN
 -- Keep the missed-deadline entry for the audit trail, including when the
 -- maintenance worker has not processed it before the completion request.
 PERFORM penalize_chore(OLD.id,as_of);
 IF NEW.completed IS DISTINCT FROM OLD.completed THEN
  IF NEW.completed THEN
   FOR person IN SELECT user_id,points FROM chore_member_points WHERE chore_id=OLD.id LOOP
    deduction := 0;
    IF OLD.due_date=as_of THEN
     SELECT COALESCE(sum(amount),0)::integer INTO deduction FROM point_ledger
      WHERE chore_id=OLD.id AND user_id=person.user_id AND kind='overdue';
    END IF;
    -- Same-day completion earns the full net reward, balancing any deduction
    -- already made at the due time. Reopening reverses this whole award.
    PERFORM post_points(person.user_id,OLD.id,'completion',person.points-deduction,as_of,as_of);
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
