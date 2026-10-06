ALTER TABLE users
  ADD COLUMN notify_due BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN notify_assignment BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN notify_requests BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE chore_requests ADD COLUMN recipient_id INT REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE push_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT UNIQUE NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en','nb')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);
CREATE TABLE push_deliveries (
  id BIGSERIAL PRIMARY KEY,
  subscription_id BIGINT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('due','assignment','requests')),
  message TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '1 day',
  reminder_chore_id INT REFERENCES chores(id) ON DELETE CASCADE,
  reminder_due_date DATE,
  next_attempt TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INT NOT NULL DEFAULT 0
);
CREATE INDEX push_deliveries_pending ON push_deliveries(next_attempt);
CREATE TABLE push_reminders (
  chore_id INT NOT NULL REFERENCES chores(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  due_date DATE NOT NULL,
  PRIMARY KEY(chore_id,user_id,due_date)
);

CREATE FUNCTION queue_push(person INT, category TEXT, message TEXT, title TEXT, url TEXT,
  expiry TIMESTAMPTZ DEFAULT now()+interval '1 day', reminder_chore INT DEFAULT NULL, reminder_due DATE DEFAULT NULL) RETURNS void LANGUAGE sql AS $$
  INSERT INTO push_deliveries(subscription_id,kind,message,title,url,expires_at,reminder_chore_id,reminder_due_date)
  SELECT s.id,category,message,title,url,expiry,reminder_chore,reminder_due FROM push_subscriptions s JOIN users u ON u.id=s.user_id
  WHERE u.id=person AND u.deleted_at IS NULL AND
    CASE category WHEN 'due' THEN u.notify_due WHEN 'assignment' THEN u.notify_assignment ELSE u.notify_requests END;
$$;

CREATE FUNCTION notify_chore_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE person INT; chore_title TEXT;
BEGIN
  IF TG_TABLE_NAME='chore_participants' THEN
    person:=NEW.user_id;
    SELECT title INTO chore_title FROM chores WHERE id=NEW.chore_id AND series_id IS NULL;
  ELSIF TG_TABLE_NAME='series_participants' THEN
    person:=NEW.user_id;
    SELECT title INTO chore_title FROM chore_series WHERE id=NEW.series_id;
  ELSE
    person:=NEW.user_id;
    IF TG_OP='UPDATE' AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id THEN RETURN NEW; END IF;
    IF TG_TABLE_NAME='chores' THEN
      IF NEW.series_id IS NOT NULL THEN RETURN NEW; END IF;
    END IF;
    chore_title:=NEW.title;
  END IF;
  IF person IS NOT NULL AND chore_title IS NOT NULL THEN
    PERFORM queue_push(person,'assignment','A chore has been assigned to you.',chore_title,'/dashboard?section=chores');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER push_chore_assignment AFTER INSERT OR UPDATE OF user_id ON chores FOR EACH ROW EXECUTE FUNCTION notify_chore_assignment();
CREATE TRIGGER push_series_assignment AFTER INSERT OR UPDATE OF user_id ON chore_series FOR EACH ROW EXECUTE FUNCTION notify_chore_assignment();
CREATE TRIGGER push_coop_assignment AFTER INSERT ON chore_participants FOR EACH ROW EXECUTE FUNCTION notify_chore_assignment();
CREATE TRIGGER push_series_coop_assignment AFTER INSERT ON series_participants FOR EACH ROW EXECUTE FUNCTION notify_chore_assignment();

CREATE FUNCTION notify_chore_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE person INT; chore_title TEXT;
BEGIN
  SELECT title INTO chore_title FROM chores WHERE id=NEW.chore_id;
  IF TG_OP='INSERT' THEN
    FOR person IN SELECT id FROM users WHERE role='admin' AND deleted_at IS NULL LOOP
      PERFORM queue_push(person,'requests','A chore request needs approval.',COALESCE(chore_title,''),'/dashboard?section=requests');
    END LOOP;
    IF NEW.recipient_id IS NOT NULL THEN
      PERFORM queue_push(NEW.recipient_id,'requests','You have received a chore request.',COALESCE(chore_title,''),'/dashboard?section=requests');
    END IF;
  ELSIF NEW.status='approved' AND OLD.status IS DISTINCT FROM 'approved' THEN
    FOR person IN SELECT DISTINCT id FROM users WHERE id IN (NEW.user_id,NEW.recipient_id) LOOP
      PERFORM queue_push(person,'requests','Your chore request has been approved.',COALESCE(chore_title,''),'/dashboard?section=requests');
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER push_request AFTER INSERT OR UPDATE OF status ON chore_requests FOR EACH ROW EXECUTE FUNCTION notify_chore_request();

CREATE FUNCTION clear_push_on_account_switch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    DELETE FROM push_deliveries WHERE subscription_id=OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER push_account_switch BEFORE UPDATE OF user_id ON push_subscriptions FOR EACH ROW EXECUTE FUNCTION clear_push_on_account_switch();
