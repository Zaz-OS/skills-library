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
