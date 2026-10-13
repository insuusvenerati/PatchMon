-- AI Terminal Assistant: allow routing the assistant through a locally
-- installed CLI agent (for example Codex or Antigravity `agy`) instead of a
-- hosted API provider.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS ai_cli_preset TEXT NOT NULL DEFAULT 'codex';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS ai_cli_command TEXT;