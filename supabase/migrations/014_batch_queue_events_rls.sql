-- Migration 014: enable RLS on batch_queue_events (narrow fix)
--
-- Clears the supabase security advisor flag added by migration 013.
-- service_role bypasses RLS so the agent + server routes are unaffected;
-- this just blocks anon/authenticated readers that shouldn't see per-row
-- process history.
--
-- The 6 sibling demo_builder.* tables (orders, sessions, usage_logs,
-- connections, prospect_rankings, batch_queue) remain RLS-disabled —
-- hardening those is a separate PR.

ALTER TABLE demo_builder.batch_queue_events ENABLE ROW LEVEL SECURITY;

-- Explicit service_role policy satisfies the linter and documents intent.
CREATE POLICY "service_role full access"
  ON demo_builder.batch_queue_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
