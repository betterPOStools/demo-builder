-- Migration 003: Change pt_record_id columns from UUID to TEXT
-- PT record IDs are Google Place IDs (e.g. "db_ChIJe9XsfetjAIkRlOO85Jfw7M8"),
-- not UUIDs. The UUID type was incorrect from the start and caused all
-- /api/batch/queue calls from the Prospect Tracker app to fail with 500.

ALTER TABLE demo_builder.sessions
  ALTER COLUMN pt_record_id TYPE TEXT USING pt_record_id::TEXT;

ALTER TABLE demo_builder.batch_queue
  ALTER COLUMN pt_record_id TYPE TEXT USING pt_record_id::TEXT;
