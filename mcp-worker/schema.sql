-- D1 Schema for skills-library catalog
-- Run: wrangler d1 execute skills-library --file=schema.sql [--local|--remote]

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,              -- "owner/repo/skill-name"
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  source TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  installs INTEGER DEFAULT 0,
  github_stars INTEGER DEFAULT 0,
  repo_url TEXT DEFAULT '',
  first_seen TEXT,
  last_updated TEXT,
  has_instructions INTEGER DEFAULT 1,
  has_scripts INTEGER DEFAULT 0,
  has_references INTEGER DEFAULT 0,
  has_assets INTEGER DEFAULT 0,
  standalone INTEGER DEFAULT 1,
  compatibility TEXT,
  license TEXT,
  allowed_tools TEXT DEFAULT '[]',
  metadata TEXT DEFAULT '{}',
  enriched INTEGER DEFAULT 0,
  body TEXT DEFAULT '',
  non_dev INTEGER DEFAULT 0,
  category TEXT DEFAULT ''          -- computed: design|writing|marketing|media|data|productivity
);

CREATE TABLE IF NOT EXISTS dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  org TEXT DEFAULT '',
  name TEXT NOT NULL,
  detected_from TEXT DEFAULT ''
);

-- FTS5 full-text search index
CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
  name, description, source, skill_id,
  content='skills', content_rowid='rowid'
);

-- FTS sync triggers: keep FTS index in sync with skills table
CREATE TRIGGER IF NOT EXISTS skills_ai AFTER INSERT ON skills BEGIN
  INSERT INTO skills_fts(rowid, name, description, source, skill_id)
  VALUES (new.rowid, new.name, new.description, new.source, new.skill_id);
END;

CREATE TRIGGER IF NOT EXISTS skills_ad AFTER DELETE ON skills BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, name, description, source, skill_id)
  VALUES ('delete', old.rowid, old.name, old.description, old.source, old.skill_id);
END;

CREATE TRIGGER IF NOT EXISTS skills_au AFTER UPDATE ON skills BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, name, description, source, skill_id)
  VALUES ('delete', old.rowid, old.name, old.description, old.source, old.skill_id);
  INSERT INTO skills_fts(rowid, name, description, source, skill_id)
  VALUES (new.rowid, new.name, new.description, new.source, new.skill_id);
END;

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_skills_installs ON skills(installs DESC);
CREATE INDEX IF NOT EXISTS idx_skills_source ON skills(source);
CREATE INDEX IF NOT EXISTS idx_skills_enriched ON skills(enriched);
CREATE INDEX IF NOT EXISTS idx_skills_standalone ON skills(standalone);
CREATE INDEX IF NOT EXISTS idx_skills_non_dev ON skills(non_dev);
CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category);

CREATE INDEX IF NOT EXISTS idx_deps_skill_id ON dependencies(skill_id);
CREATE INDEX IF NOT EXISTS idx_deps_type_name ON dependencies(type, name);
