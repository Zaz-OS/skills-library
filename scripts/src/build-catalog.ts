import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Skill,
  ScrapedSkill,
  RepoData,
  GitHubMeta,
  DependencyIndex,
  CatalogStats,
} from "../../types/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "../../data");
const RAW_DIR = join(DATA_DIR, "raw");

function loadExistingCatalog(): Skill[] {
  try {
    const path = join(DATA_DIR, "skills.json");
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf-8"));
    }
  } catch {
    // Ignore
  }
  return [];
}

export function buildCatalog(
  scrapedSkills: ScrapedSkill[],
  repos: RepoData[],
  githubMeta: GitHubMeta
): {
  skills: Skill[];
  dependencies: DependencyIndex;
  stats: CatalogStats;
  llmsTxt: string;
  llmsFullTxt: string;
  searchIndex: object[];
} {
  const existing = loadExistingCatalog();
  const existingMap = new Map(existing.map((s) => [s.id, s]));
  const scrapedMap = new Map(scrapedSkills.map((s) => [`${s.source}/${s.skillId}`, s]));
  const repoMap = new Map(repos.map((r) => [r.source, r]));
  const now = new Date().toISOString();

  const skills: Skill[] = [];

  // Build skills from repo data (primary source)
  for (const repo of repos) {
    const meta = githubMeta[repo.source];

    for (const repoSkill of repo.skills) {
      const id = `${repo.source}/${repoSkill.skillId}`;
      const scraped = scrapedMap.get(id);
      const prev = existingMap.get(id);

      const skill: Skill = {
        id,
        name: repoSkill.parsed.name || scraped?.name || repoSkill.skillId,
        description: repoSkill.parsed.description || "",
        source: repo.source,
        skillId: repoSkill.skillId,

        installs: scraped?.installs ?? prev?.installs ?? 0,
        githubStars: meta?.stars ?? prev?.githubStars ?? 0,
        repoUrl: repo.repoUrl,
        firstSeen: prev?.firstSeen ?? now,
        lastUpdated: now,

        contentType: repoSkill.contentType,
        standalone: repoSkill.dependencies.length === 0,
        dependencies: repoSkill.dependencies,

        compatibility: repoSkill.parsed.compatibility,
        license: repoSkill.parsed.license,
        allowedTools: repoSkill.parsed.allowedTools,
        metadata: repoSkill.parsed.metadata,
      };

      skills.push(skill);
    }
  }

  // Add scraped skills that weren't found in repos
  for (const [id, scraped] of scrapedMap) {
    if (!skills.some((s) => s.id === id)) {
      const prev = existingMap.get(id);
      skills.push({
        id,
        name: scraped.name,
        description: "",
        source: scraped.source,
        skillId: scraped.skillId,

        installs: scraped.installs,
        githubStars: githubMeta[scraped.source]?.stars ?? 0,
        repoUrl: `https://github.com/${scraped.source}`,
        firstSeen: prev?.firstSeen ?? now,
        lastUpdated: now,

        contentType: {
          hasInstructions: true,
          hasScripts: false,
          hasReferences: false,
          hasAssets: false,
        },
        standalone: true,
        dependencies: [],

        compatibility: null,
        license: null,
        allowedTools: [],
        metadata: {},
      });
    }
  }

  // Preserve skills from previous catalog that weren't found in this run
  // (scraper results vary between runs; don't lose previously discovered skills)
  const currentIds = new Set(skills.map((s) => s.id));
  for (const prev of existing) {
    if (!currentIds.has(prev.id)) {
      skills.push(prev);
    }
  }

  // Sort by installs descending
  skills.sort((a, b) => b.installs - a.installs);

  // Build dependency index
  const dependencies = buildDependencyIndex(skills);

  // Build stats
  const stats = buildStats(skills);

  // Build llms.txt
  const llmsTxt = buildLlmsTxt();
  const llmsFullTxt = buildLlmsFullTxt(skills);

  // Build search index
  const searchIndex = buildSearchIndex(skills);

  return { skills, dependencies, stats, llmsTxt, llmsFullTxt, searchIndex };
}

function buildDependencyIndex(skills: Skill[]): DependencyIndex {
  const index: DependencyIndex = {};

  for (const skill of skills) {
    for (const dep of skill.dependencies) {
      if (!index[dep.type]) index[dep.type] = {};
      const typeIndex = index[dep.type];

      const key = dep.org !== dep.name ? `${dep.org}/${dep.name}` : dep.name;
      if (!typeIndex[key]) typeIndex[key] = { skills: [], count: 0 };

      typeIndex[key].skills.push(skill.id);
      typeIndex[key].count++;
    }
  }

  return index;
}

function buildStats(skills: Skill[]): CatalogStats {
  const uniqueRepos = new Set(skills.map((s) => s.source));
  const byDepType: Record<string, number> = {};

  for (const skill of skills) {
    for (const dep of skill.dependencies) {
      byDepType[dep.type] = (byDepType[dep.type] ?? 0) + 1;
    }
  }

  return {
    totalSkills: skills.length,
    totalRepos: uniqueRepos.size,
    standaloneCount: skills.filter((s) => s.standalone).length,
    withDepsCount: skills.filter((s) => !s.standalone).length,
    byContentType: {
      instructionsOnly: skills.filter(
        (s) => !s.contentType.hasScripts && !s.contentType.hasReferences && !s.contentType.hasAssets
      ).length,
      withScripts: skills.filter((s) => s.contentType.hasScripts).length,
      withReferences: skills.filter((s) => s.contentType.hasReferences).length,
      withAssets: skills.filter((s) => s.contentType.hasAssets).length,
    },
    byDependencyType: byDepType,
    lastUpdated: new Date().toISOString(),
  };
}

function buildLlmsTxt(): string {
  return `# skills-library

> Searchable catalog of AI agent skills from skills.sh with dependency mapping and content classification.

## Skills Catalog
- [Full JSON catalog](/api/skills.json): Complete skills data with dependencies, content types, installs, and GitHub stars
- [Dependencies index](/api/deps.json): Skills grouped by dependency type and package

## Documentation
- [About this project](/about): How skills-library works and how to contribute
- [Data format](/api): API documentation for the JSON endpoints

## Optional
- [Extended catalog](/llms-full.txt): Full descriptions of all skills in plain text
`;
}

function buildLlmsFullTxt(skills: Skill[]): string {
  const lines: string[] = [
    "# skills-library — Full Catalog",
    "",
    `> ${skills.length} AI agent skills indexed from skills.sh`,
    "",
    "---",
    "",
  ];

  for (const skill of skills) {
    lines.push(`## ${skill.name}`);
    lines.push(`- ID: ${skill.id}`);
    lines.push(`- Installs: ${skill.installs}`);
    lines.push(`- Stars: ${skill.githubStars}`);
    lines.push(`- Standalone: ${skill.standalone ? "yes" : "no"}`);

    if (skill.description) {
      lines.push(`- Description: ${skill.description}`);
    }

    if (skill.dependencies.length > 0) {
      lines.push(`- Dependencies: ${skill.dependencies.map((d) => `${d.name} (${d.type})`).join(", ")}`);
    }

    const contentParts: string[] = [];
    if (skill.contentType.hasScripts) contentParts.push("scripts");
    if (skill.contentType.hasReferences) contentParts.push("references");
    if (skill.contentType.hasAssets) contentParts.push("assets");
    if (contentParts.length > 0) {
      lines.push(`- Content: instructions + ${contentParts.join(", ")}`);
    } else {
      lines.push(`- Content: instructions only`);
    }

    lines.push(`- Repo: ${skill.repoUrl}`);
    lines.push("");
  }

  return lines.join("\n");
}

const TECHNICAL_KEYWORDS =
  /\b(api|sdk|cli|npm|pip|docker|kubernetes|k8s|terraform|devops|cicd|ci\/cd|backend|database|sql|nosql|graphql|grpc|microservice|deploy|git(?:hub|lab)?|aws|azure|gcloud|serverless|webpack|vite|eslint|prettier|jest|pytest|playwright|cypress|debug|compiler|runtime|binary|middleware|oauth|jwt|endpoint|webhook|localhost|daemon|container|ssh|ssl|tls|nginx|apache|redis|postgres|mysql|mongodb|kafka|elasticsearch|cron|bash|shell|powershell|regex|refactor|linting|typescript|javascript|python|rust|golang|kotlin|swift|flutter|react|nextjs|next\.js|vue|angular|svelte|nuxt|remix|astro|node\.js|deno|bun|express|fastapi|django|flask|rails|laravel|spring|supabase|prisma|drizzle|sequelize|mongoose|tailwindcss|sass|webpack|rollup|turbopack|storybook|nx|monorepo|ci|cd|yaml|json|xml|csv|protobuf|websocket|tcp|udp|http|rest|soap|rpc|ssr|ssg|hydration|jsx|tsx|component|hook|state.?management|routing|orm|migration|schema|query|index|cache|cdn|load.?balanc|proxy|gateway|queue|pub.?sub|event.?driven|hexagonal|clean.?arch|solid|design.?pattern|unit.?test|e2e|integration.?test|mock|stub|fixture|assertion|benchmark|profil|heap|stack|thread|async|promise|callback|observable|stream|buffer|pipe|stdin|stdout|stderr|env|dotenv|config|secret|token|credential|certificate|key.?pair|encrypt|decrypt|hash|salt|bcrypt|argon|crypto)\b/i;

function isNonDeveloper(s: Skill): boolean {
  if (!s.standalone) return false;
  if (s.contentType.hasScripts) return false;
  const text = s.name + " " + (s.description || "");
  return !TECHNICAL_KEYWORDS.test(text);
}

function buildSearchIndex(skills: Skill[]): object[] {
  return skills.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    source: s.source,
    skillId: s.skillId,
    installs: s.installs,
    stars: s.githubStars,
    standalone: s.standalone,
    deps: s.dependencies.map((d) => d.name).join(" "),
    depTypes: [...new Set(s.dependencies.map((d) => d.type))].join(" "),
    content: [
      s.contentType.hasScripts ? "scripts" : "",
      s.contentType.hasReferences ? "references" : "",
      s.contentType.hasAssets ? "assets" : "",
    ]
      .filter(Boolean)
      .join(" "),
    nonDev: isNonDeveloper(s),
  }));
}

export function writeCatalog(catalog: ReturnType<typeof buildCatalog>): void {
  mkdirSync(DATA_DIR, { recursive: true });

  writeFileSync(join(DATA_DIR, "skills.json"), JSON.stringify(catalog.skills, null, 2));
  writeFileSync(join(DATA_DIR, "dependencies.json"), JSON.stringify(catalog.dependencies, null, 2));
  writeFileSync(join(DATA_DIR, "stats.json"), JSON.stringify(catalog.stats, null, 2));
  writeFileSync(join(DATA_DIR, "llms.txt"), catalog.llmsTxt);
  writeFileSync(join(DATA_DIR, "llms-full.txt"), catalog.llmsFullTxt);
  writeFileSync(join(DATA_DIR, "search-index.json"), JSON.stringify(catalog.searchIndex));

  console.log(`Catalog written to ${DATA_DIR}/`);
  console.log(`  ${catalog.skills.length} skills`);
  console.log(`  ${catalog.stats.standaloneCount} standalone`);
  console.log(`  ${catalog.stats.withDepsCount} with dependencies`);
}

// Direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const scrapedFile = join(RAW_DIR, "skills-sh.json");
  const metaFile = join(RAW_DIR, "github-meta.json");

  if (!existsSync(scrapedFile)) {
    console.error("Run pipeline steps first");
    process.exit(1);
  }

  const scraped: ScrapedSkill[] = JSON.parse(readFileSync(scrapedFile, "utf-8"));
  const githubMeta: GitHubMeta = existsSync(metaFile)
    ? JSON.parse(readFileSync(metaFile, "utf-8"))
    : {};

  // Load repo data
  const reposDir = join(RAW_DIR, "repos");
  const repos: RepoData[] = [];
  if (existsSync(reposDir)) {
    const { readdirSync } = await import("node:fs");
    for (const file of readdirSync(reposDir)) {
      if (file.endsWith(".json")) {
        repos.push(JSON.parse(readFileSync(join(reposDir, file), "utf-8")));
      }
    }
  }

  const catalog = buildCatalog(scraped, repos, githubMeta);
  writeCatalog(catalog);
}
