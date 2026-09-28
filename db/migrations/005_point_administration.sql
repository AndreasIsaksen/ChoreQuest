ALTER TABLE point_ledger DROP CONSTRAINT point_ledger_kind_check;
ALTER TABLE point_ledger ADD CHECK(kind IN ('completion','reopen','overdue','admin_adjustment'));
ALTER TABLE point_ledger ADD COLUMN actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE point_ledger ADD COLUMN account_type TEXT CHECK(account_type IN ('weekly','permanent'));
ALTER TABLE point_ledger ADD COLUMN reason TEXT;
ALTER TABLE point_ledger ADD COLUMN balance_before BIGINT;
ALTER TABLE point_ledger ADD COLUMN balance_after BIGINT;
ALTER TABLE point_ledger ADD COLUMN request_id UUID UNIQUE;
ALTER TABLE point_ledger ADD CHECK(kind<>'admin_adjustment' OR
 (account_type IS NOT NULL AND reason IS NOT NULL AND balance_before IS NOT NULL AND balance_after IS NOT NULL AND request_id IS NOT NULL));
CREATE INDEX point_adjustment_history ON point_ledger(user_id,created_at DESC,id DESC) WHERE kind='admin_adjustment';
