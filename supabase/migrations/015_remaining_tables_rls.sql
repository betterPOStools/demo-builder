-- Migration 015: enable RLS on remaining demo_builder tables
--
-- Completes the hardening deferred in migration 014 ("separate PR").
-- All 6 tables are accessed exclusively via server-side API routes using
-- the service_role key, which bypasses RLS by design. Enabling RLS with
-- a service_role-only policy blocks any anon/authenticated reads via
-- PostgREST without changing app behavior.
--
-- Verified before applying: demo_builder.connections (1 row on DEV, 2 on PROD)
-- and demo_builder.sessions (5 rows DEV, 3 PROD) were readable by anon key.
-- demo_builder.usage_logs, batch_queue, prospect_rankings also exposed.
--
-- ⚠️ Irreversible (schema change). To roll back:
--   ALTER TABLE demo_builder.<table> DISABLE ROW LEVEL SECURITY;

-- ─── sessions ────────────────────────────────────────────────────────────────
ALTER TABLE demo_builder.sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role full access"
  ON demo_builder.sessions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ─── connections ─────────────────────────────────────────────────────────────
-- CRITICAL: contains password_encrypted (MariaDB credentials). Was anon-readable.
ALTER TABLE demo_builder.connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role full access"
  ON demo_builder.connections
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ─── usage_logs ──────────────────────────────────────────────────────────────
ALTER TABLE demo_builder.usage_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role full access"
  ON demo_builder.usage_logs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ─── batch_queue ─────────────────────────────────────────────────────────────
ALTER TABLE demo_builder.batch_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role full access"
  ON demo_builder.batch_queue
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ─── prospect_rankings ───────────────────────────────────────────────────────
ALTER TABLE demo_builder.prospect_rankings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role full access"
  ON demo_builder.prospect_rankings
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ─── orders ──────────────────────────────────────────────────────────────────
-- Created by online-ordering/migrations/001_orders.sql in the same schema.
ALTER TABLE demo_builder.orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role full access"
  ON demo_builder.orders
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
