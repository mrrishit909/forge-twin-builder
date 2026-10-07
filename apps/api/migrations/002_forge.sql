-- FORGE domain tables (blueprint 10 section 5), with tenant_id, created_by, updated_at and row-level security added. Additions
-- are marked (+). Branch scenes are kept as a base snapshot plus an op log (scene_ops), the same model the browser uses.
CREATE TABLE twin_projects (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES organizations(id),
  tenant_id UUID NOT NULL REFERENCES organizations(id),   -- (+) = org_id; named for the RLS policy
  name TEXT NOT NULL,
  status TEXT,
  created_by TEXT, updated_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- assets of the production branch (the live twin that telemetry binds to); other branches live in scenario_branches
CREATE TABLE assets (
  id TEXT NOT NULL,                                       -- scene asset ids are strings chosen by the editor
  project_id UUID REFERENCES twin_projects(id),
  tenant_id UUID NOT NULL REFERENCES organizations(id),   -- (+)
  asset_type TEXT NOT NULL CHECK (asset_type IN ('source','conveyor','machine','robot','buffer','sink')),
  name TEXT,
  transform JSONB NOT NULL,
  geometry_uri TEXT,
  properties JSONB,
  deleted_at TIMESTAMPTZ,                                 -- (+) soft delete
  updated_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (project_id, id)
);

CREATE TABLE connectors (
  id UUID PRIMARY KEY,
  project_id UUID REFERENCES twin_projects(id),
  tenant_id UUID NOT NULL REFERENCES organizations(id),   -- (+)
  connector_type TEXT CHECK (connector_type IN ('mqtt','opcua','modbus_gateway','rest','kafka')),
  config_encrypted BYTEA NOT NULL,                        -- AES-256-GCM: iv | tag | ciphertext; the key is never in the database
  label TEXT,                                             -- (+) safe to show
  status TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE telemetry_bindings (
  id TEXT PRIMARY KEY,
  project_id UUID NOT NULL,                               -- (+)
  asset_id TEXT NOT NULL,
  tenant_id UUID NOT NULL REFERENCES organizations(id),   -- (+)
  connector_id UUID REFERENCES connectors(id),
  source_path TEXT NOT NULL,
  target_property TEXT NOT NULL,
  transform_expression TEXT,
  unit TEXT,
  FOREIGN KEY (project_id, asset_id) REFERENCES assets(project_id, id)
);

CREATE TABLE telemetry_points (
  project_id UUID NOT NULL,                               -- (+)
  asset_id TEXT NOT NULL,
  tenant_id UUID NOT NULL,                                -- (+)
  metric TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  value DOUBLE PRECISION,
  PRIMARY KEY (project_id, asset_id, metric, ts)
);

CREATE TABLE scenario_branches (
  id TEXT NOT NULL,                                       -- branch ids are names ("production", "expansion")
  project_id UUID NOT NULL REFERENCES twin_projects(id),  -- (+)
  tenant_id UUID NOT NULL REFERENCES organizations(id),   -- (+)
  parent_branch_id TEXT,
  name TEXT,
  scene_snapshot_uri TEXT,
  base_scene JSONB NOT NULL,                              -- (+) the snapshot the branch started from (three-way merge base)
  parameters JSONB,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (project_id, id)
);

CREATE TABLE scene_ops (                                  -- (+) every edit, stamped (Lamport clock, actor), in arrival order
  seq BIGSERIAL PRIMARY KEY,
  project_id UUID NOT NULL, branch_id TEXT NOT NULL, tenant_id UUID NOT NULL,
  op JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT now(),
  FOREIGN KEY (project_id, branch_id) REFERENCES scenario_branches(project_id, id)
);

CREATE TABLE simulation_runs (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL,                               -- (+)
  branch_id TEXT NOT NULL,
  tenant_id UUID NOT NULL REFERENCES organizations(id),   -- (+)
  engine TEXT,
  status TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  kpis JSONB,
  result_uri TEXT,
  FOREIGN KEY (project_id, branch_id) REFERENCES scenario_branches(project_id, id)
);

CREATE TABLE comments (                                   -- (+) world-space comments
  id TEXT PRIMARY KEY, project_id UUID NOT NULL REFERENCES twin_projects(id), tenant_id UUID NOT NULL,
  author TEXT, asset_id TEXT, position JSONB NOT NULL, text TEXT NOT NULL CHECK (length(text) <= 280), created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE client_telemetry (id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ DEFAULT now(), sample JSONB NOT NULL); -- (+)

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'forge_app') THEN CREATE ROLE forge_app LOGIN PASSWORD 'app-dev-only'; END IF;
END $$;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO forge_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO forge_app;
REVOKE UPDATE, DELETE ON audit_log FROM forge_app;
REVOKE UPDATE ON scene_ops FROM forge_app;
-- pooled connections can come back with app.tenant = '' (not NULL); NULLIF makes that "no tenant" instead of a cast error
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['twin_projects','assets','connectors','telemetry_bindings','telemetry_points','scenario_branches','scene_ops','simulation_runs','comments','audit_log','idempotency_keys'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant'', true), '''')::uuid)', t);
  END LOOP;
END $$;
