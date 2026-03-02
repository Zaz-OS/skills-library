import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Fuse from "fuse.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Skill {
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
  contentType: {
    hasInstructions: boolean;
    hasScripts: boolean;
    hasReferences: boolean;
    hasAssets: boolean;
  };
  standalone: boolean;
  dependencies: {
    type: string;
    org: string;
    name: string;
    detectedFrom: string;
  }[];
  compatibility: string | null;
  license: string | null;
  allowedTools: string[];
  metadata: Record<string, string>;
}

interface DependencyIndex {
  [type: string]: {
    [orgOrName: string]: {
      skills: string[];
      count: number;
    };
  };
}

interface CatalogStats {
  totalSkills: number;
  totalRepos: number;
  standaloneCount: number;
  withDepsCount: number;
  byContentType: Record<string, number>;
  byDependencyType: Record<string, number>;
  lastUpdated: string;
}

let cachedSkills: Skill[] | null = null;
let cachedDeps: DependencyIndex | null = null;
let cachedStats: CatalogStats | null = null;
let cachedFuse: Fuse<Skill> | null = null;

// Try to load from local data/ first, then fall back to fetching from the deployed site
const DATA_URL_BASE = process.env.SKILLS_LIBRARY_URL || "https://skills-library.pages.dev";

async function fetchJson<T>(path: string): Promise<T | null> {
  // Try local file first
  const localPath = join(__dirname, "../../data", path);
  if (existsSync(localPath)) {
    return JSON.parse(readFileSync(localPath, "utf-8"));
  }

  // Fetch from remote
  try {
    const res = await fetch(`${DATA_URL_BASE}/api/${path}`);
    if (res.ok) return (await res.json()) as T;
  } catch {
    // Fetch failed
  }

  return null;
}

export async function getSkills(): Promise<Skill[]> {
  if (!cachedSkills) {
    cachedSkills = (await fetchJson<Skill[]>("skills.json")) ?? [];
  }
  return cachedSkills;
}

export async function getDependencyIndex(): Promise<DependencyIndex> {
  if (!cachedDeps) {
    cachedDeps = (await fetchJson<DependencyIndex>("dependencies.json")) ?? {};
  }
  return cachedDeps;
}

export async function getStats(): Promise<CatalogStats> {
  if (!cachedStats) {
    cachedStats = (await fetchJson<CatalogStats>("stats.json")) ?? {
      totalSkills: 0,
      totalRepos: 0,
      standaloneCount: 0,
      withDepsCount: 0,
      byContentType: {},
      byDependencyType: {},
      lastUpdated: "",
    };
  }
  return cachedStats;
}

export async function getFuse(): Promise<Fuse<Skill>> {
  if (!cachedFuse) {
    const skills = await getSkills();
    cachedFuse = new Fuse(skills, {
      keys: [
        { name: "name", weight: 2 },
        { name: "description", weight: 1.5 },
        { name: "skillId", weight: 1 },
        { name: "source", weight: 0.5 },
      ],
      threshold: 0.3,
      includeScore: true,
    });
  }
  return cachedFuse;
}

export async function searchSkills(
  query: string,
  options?: {
    standaloneOnly?: boolean;
    contentType?: string[];
  }
): Promise<Skill[]> {
  const fuse = await getFuse();
  let results = fuse.search(query).map((r) => r.item);

  if (options?.standaloneOnly) {
    results = results.filter((s) => s.standalone);
  }

  if (options?.contentType?.length) {
    results = results.filter((s) => {
      for (const ct of options.contentType!) {
        if (ct === "scripts" && !s.contentType.hasScripts) return false;
        if (ct === "references" && !s.contentType.hasReferences) return false;
        if (ct === "assets" && !s.contentType.hasAssets) return false;
      }
      return true;
    });
  }

  return results;
}

export async function getSkillById(id: string): Promise<Skill | undefined> {
  const skills = await getSkills();
  return skills.find((s) => s.id === id);
}

export async function listByDependency(
  dependency: string,
  type?: string
): Promise<Skill[]> {
  const skills = await getSkills();
  return skills.filter((s) =>
    s.dependencies.some(
      (d) =>
        (d.name.includes(dependency) || d.org.includes(dependency)) &&
        (!type || d.type === type)
    )
  );
}

export async function listStandalone(
  sortBy: "installs" | "stars" | "name" = "installs"
): Promise<Skill[]> {
  const skills = await getSkills();
  const standalone = skills.filter((s) => s.standalone);

  switch (sortBy) {
    case "stars":
      return standalone.sort((a, b) => b.githubStars - a.githubStars);
    case "name":
      return standalone.sort((a, b) => a.name.localeCompare(b.name));
    default:
      return standalone.sort((a, b) => b.installs - a.installs);
  }
}
