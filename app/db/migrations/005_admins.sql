-- ────────────────────────────────────────────────────────── two accounts ──
--
-- There are members and there are admins. That is the whole list.
--
-- Three things were carrying a third idea and none of them earned it:
--
--   * `staff_users.role` split admins from coaches, so half the master
--     dashboard was written twice, once with a control and once without. Every
--     coach here is somebody who can also change a price, so the split was
--     describing a distinction the club does not make.
--   * `members.role` was a leftover from before admins were their own table.
--     Nothing read it. A column that looks like a privilege flag and is wired
--     to nothing is worse than no column at all: the next person to find it
--     will assume setting it does something.
--   * "staff" as a name only makes sense when there is a rank below it.
--
-- So: the role columns go, and the tables say what they hold.

-- Anybody who could reach the master dashboard can now do all of it.
ALTER TABLE staff_users DROP CONSTRAINT IF EXISTS staff_users_role_check;
ALTER TABLE staff_users DROP COLUMN role;

-- Dead since admins became their own table.
ALTER TABLE members DROP CONSTRAINT IF EXISTS members_role_check;
ALTER TABLE members DROP COLUMN role;

ALTER TABLE staff_users    RENAME TO admins;
ALTER TABLE staff_sessions RENAME TO admin_sessions;

ALTER TABLE admin_sessions      RENAME COLUMN staff_id TO admin_id;
ALTER TABLE audit_log           RENAME COLUMN staff_id TO admin_id;
ALTER TABLE plan_price_changes  RENAME COLUMN staff_id TO admin_id;

ALTER INDEX staff_users_email_key   RENAME TO admins_email_key;
ALTER INDEX staff_sessions_staff_idx RENAME TO admin_sessions_admin_idx;
ALTER INDEX audit_log_staff_idx      RENAME TO audit_log_admin_idx;

COMMENT ON COLUMN payments.recorded_by IS
  'Set when an admin recorded the payment by hand, rather than a processor reporting it.';

-- The audit trail names who acted; "staff" was the same third idea again.
UPDATE audit_log SET actor = 'admin' WHERE actor = 'staff';
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_actor_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_check
  CHECK (actor IN ('member', 'admin', 'system'));

UPDATE audit_log SET action = replace(action, 'staff.', 'admin.')
 WHERE action LIKE 'staff.%';
