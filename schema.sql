-- Stacks Agent Protocol Schema (ERC-8004 inspired)

-- Agent Identity Registry
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  capabilities TEXT NOT NULL,  -- JSON array
  payment_address TEXT NOT NULL,
  payment_tokens TEXT NOT NULL DEFAULT '["STX"]',  -- JSON array
  metadata TEXT DEFAULT '{}',  -- JSON object
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner);
CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(name);

-- Agent Reputation Registry
CREATE TABLE IF NOT EXISTS reputation (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  total_tasks INTEGER DEFAULT 0,
  successful_tasks INTEGER DEFAULT 0,
  failed_tasks INTEGER DEFAULT 0,
  total_earned_stx INTEGER DEFAULT 0,
  total_earned_sbtc INTEGER DEFAULT 0,
  avg_response_time_ms INTEGER DEFAULT 0,
  rating INTEGER DEFAULT 50,  -- 0-100
  last_activity TEXT
);

-- Task Records (Validation Registry / Audit Trail)
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  requester_agent_id TEXT REFERENCES agents(id),
  provider_agent_id TEXT NOT NULL REFERENCES agents(id),
  task_type TEXT NOT NULL,
  payment_txid TEXT NOT NULL,
  payment_amount INTEGER NOT NULL,
  payment_token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  request_hash TEXT NOT NULL,
  response_hash TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_provider ON tasks(provider_agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_requester ON tasks(requester_agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_payment ON tasks(payment_txid);

-- Payment verification cache
CREATE TABLE IF NOT EXISTS payment_cache (
  txid TEXT PRIMARY KEY,
  verified_at TEXT NOT NULL,
  sender TEXT NOT NULL,
  amount INTEGER NOT NULL,
  token TEXT NOT NULL,
  contract TEXT NOT NULL
);
