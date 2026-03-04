export interface Dependency {
  type: "npm" | "pip" | "brew" | "system" | "service" | "other";
  org: string;
  name: string;
  detectedFrom: "compatibility" | "instructions" | "scripts";
}

export interface ContentType {
  hasInstructions: boolean;
  hasScripts: boolean;
  hasReferences: boolean;
  hasAssets: boolean;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  source: string;
  skillId: string;

  installs: number;
  githubStars: number;
  repoUrl: string;
  firstSeen: string;
  lastUpdated: string;

  contentType: ContentType;

  standalone: boolean;
  dependencies: Dependency[];

  compatibility: string | null;
  license: string | null;
  allowedTools: string[];
  metadata: Record<string, string>;
}

export interface DependencyIndexEntry {
  skills: string[];
  count: number;
}

export interface DependencyIndex {
  [type: string]: {
    [orgOrName: string]: DependencyIndexEntry;
  };
}

export interface CatalogStats {
  totalSkills: number;
  totalRepos: number;
  standaloneCount: number;
  withDepsCount: number;
  byContentType: {
    instructionsOnly: number;
    withScripts: number;
    withReferences: number;
    withAssets: number;
  };
  byDependencyType: Record<string, number>;
  lastUpdated: string;
}

export interface ScrapedSkill {
  source: string;
  skillId: string;
  name: string;
  installs: number;
}

export interface ParsedSkillMd {
  name: string;
  description: string;
  compatibility: string | null;
  license: string | null;
  allowedTools: string[];
  metadata: Record<string, string>;
  body: string;
}

export interface RepoData {
  source: string;
  repoUrl: string;
  skills: {
    skillId: string;
    parsed: ParsedSkillMd;
    contentType: ContentType;
    dependencies: Dependency[];
  }[];
}

export interface GitHubMeta {
  [repo: string]: {
    stars: number;
    etag?: string;
    fetchedAt: string;
  };
}

// ── D1 Row Types (snake_case for SQL columns) ────────────────────────

export interface SkillRow {
  id: string;
  name: string;
  description: string;
  source: string;
  skill_id: string;
  installs: number;
  github_stars: number;
  repo_url: string;
  first_seen: string | null;
  last_updated: string | null;
  has_instructions: number;
  has_scripts: number;
  has_references: number;
  has_assets: number;
  standalone: number;
  compatibility: string | null;
  license: string | null;
  allowed_tools: string;
  metadata: string;
  enriched: number;
  body: string;
  non_dev: number;
  category: string;
}

export interface DependencyRow {
  id: number;
  skill_id: string;
  type: string;
  org: string;
  name: string;
  detected_from: string;
}

// ── Conversion Helpers ───────────────────────────────────────────────

export function skillRowToSkill(row: SkillRow, deps?: DependencyRow[]): Skill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    source: row.source,
    skillId: row.skill_id,
    installs: row.installs,
    githubStars: row.github_stars,
    repoUrl: row.repo_url,
    firstSeen: row.first_seen ?? "",
    lastUpdated: row.last_updated ?? "",
    contentType: {
      hasInstructions: row.has_instructions === 1,
      hasScripts: row.has_scripts === 1,
      hasReferences: row.has_references === 1,
      hasAssets: row.has_assets === 1,
    },
    standalone: row.standalone === 1,
    dependencies: (deps ?? []).map((d) => ({
      type: d.type as Dependency["type"],
      org: d.org,
      name: d.name,
      detectedFrom: d.detected_from as Dependency["detectedFrom"],
    })),
    compatibility: row.compatibility,
    license: row.license,
    allowedTools: JSON.parse(row.allowed_tools || "[]"),
    metadata: JSON.parse(row.metadata || "{}"),
  };
}

export function skillToRow(skill: Skill): Omit<SkillRow, "enriched" | "body" | "non_dev" | "category"> {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    source: skill.source,
    skill_id: skill.skillId,
    installs: skill.installs,
    github_stars: skill.githubStars,
    repo_url: skill.repoUrl,
    first_seen: skill.firstSeen || null,
    last_updated: skill.lastUpdated || null,
    has_instructions: skill.contentType.hasInstructions ? 1 : 0,
    has_scripts: skill.contentType.hasScripts ? 1 : 0,
    has_references: skill.contentType.hasReferences ? 1 : 0,
    has_assets: skill.contentType.hasAssets ? 1 : 0,
    standalone: skill.standalone ? 1 : 0,
    compatibility: skill.compatibility,
    license: skill.license,
    allowed_tools: JSON.stringify(skill.allowedTools),
    metadata: JSON.stringify(skill.metadata),
  };
}
