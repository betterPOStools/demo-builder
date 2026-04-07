-- Demo Builder schema
-- Unified pipeline: extract → design → deploy

CREATE SCHEMA IF NOT EXISTS demo_builder;

-- Project sessions (full pipeline state)
CREATE TABLE demo_builder.sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email TEXT NOT NULL,
  name TEXT DEFAULT 'Untitled',
  restaurant_name TEXT,
  restaurant_type TEXT,

  -- Step 1: Extraction
  extracted_rows JSONB,
  modifier_suggestions JSONB,
  source_summary JSONB,

  -- Step 2: Design
  design_state JSONB,
  modifier_templates JSONB,

  -- Step 3: Deploy
  generated_sql TEXT,
  pending_images JSONB DEFAULT '[]',
  deploy_target JSONB,
  deploy_status TEXT DEFAULT 'idle',
  deploy_result JSONB,

  current_step INT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Usage logging
CREATE TABLE demo_builder.usage_logs (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID REFERENCES demo_builder.sessions(id),
  user_email TEXT,
  model TEXT,
  source_type TEXT,
  input_tokens INT DEFAULT 0,
  output_tokens INT DEFAULT 0,
  cache_read_tokens INT DEFAULT 0,
  cost NUMERIC(10,6),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Deploy agent targets (saved connections)
CREATE TABLE demo_builder.connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email TEXT NOT NULL,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INT DEFAULT 3306,
  database_name TEXT NOT NULL,
  username TEXT NOT NULL,
  password_encrypted TEXT NOT NULL,
  upload_server_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_sessions_user ON demo_builder.sessions (user_email, updated_at DESC);
CREATE INDEX idx_sessions_deploy ON demo_builder.sessions (deploy_status) WHERE deploy_status = 'queued';
CREATE INDEX idx_usage_session ON demo_builder.usage_logs (session_id);
CREATE INDEX idx_connections_user ON demo_builder.connections (user_email);
