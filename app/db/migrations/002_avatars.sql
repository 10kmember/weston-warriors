-- Default avatars.
--
-- Members choose from a fixed set of illustrations. There is no upload path in
-- the product and none in the schema either: this column holds a key from
-- assets/avatars/manifest.json, nothing more. No file is ever accepted from a
-- member, so there is no image handling, no storage bucket, no EXIF to strip
-- and no moderation problem.

BEGIN;

ALTER TABLE members
  ADD COLUMN avatar_key text NOT NULL DEFAULT 'green-calm';

COMMENT ON COLUMN members.avatar_key IS
  'Key from assets/avatars/manifest.json. Validated in the application against that manifest.';

INSERT INTO schema_migrations (version) VALUES ('002_avatars');

COMMIT;
