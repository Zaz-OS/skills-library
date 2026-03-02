import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkillMd } from "./utils/skill-parser.js";
import {
  detectFromCompatibility,
  detectFromInstructions,
  detectFromScripts,
  deduplicateDeps,
} from "./utils/dependency-detector.js";
import type { ScrapedSkill, RepoData, ContentType, Dependency } from "../../types/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "../../data/raw");
const REPOS_DIR = join(DATA_DIR, "repos");
const CLONE_DIR = join(__dirname, "../../.tmp/repos");

function groupBySource(skills: ScrapedSkill[]): Map<string, ScrapedSkill[]> {
  const groups = new Map<string, ScrapedSkill[]>();
  for (const skill of skills) {
    const existing = groups.get(skill.source) ?? [];
    existing.push(skill);
    groups.set(skill.source, existing);
  }
  return groups;
}

function cloneRepo(source: string): string | null {
  const repoUrl = `https://github.com/${source}.git`;
  const cloneDir = join(CLONE_DIR, source.replace("/", "__"));

  try {
    // Clean up any existing clone
    if (existsSync(cloneDir)) {
      rmSync(cloneDir, { recursive: true, force: true });
    }

    mkdirSync(dirname(cloneDir), { recursive: true });

    // Shallow clone with sparse checkout
    execSync(
      `git clone --depth 1 --filter=blob:none --sparse "${repoUrl}" "${cloneDir}"`,
      { stdio: "pipe", timeout: 60_000 }
    );

    // Set sparse checkout to only get skills directories
    execSync("git sparse-checkout set skills", {
      cwd: cloneDir,
      stdio: "pipe",
      timeout: 30_000,
    });

    // If no skills/ dir, try checking out everything
    const skillsDir = join(cloneDir, "skills");
    if (!existsSync(skillsDir)) {
      execSync("git sparse-checkout disable", {
        cwd: cloneDir,
        stdio: "pipe",
        timeout: 30_000,
      });
    }

    return cloneDir;
  } catch (err) {
    console.error(`Failed to clone ${source}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

function findSkillMdFiles(dir: string): { skillId: string; path: string }[] {
  const results: { skillId: string; path: string }[] = [];

  function walk(current: string, depth: number) {
    if (depth > 5) return;
    try {
      const entries = readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        const fullPath = join(current, entry.name);
        if (entry.isDirectory()) {
          // Check if this directory contains a SKILL.md
          const skillMdPath = join(fullPath, "SKILL.md");
          if (existsSync(skillMdPath)) {
            results.push({ skillId: entry.name, path: skillMdPath });
          }
          walk(fullPath, depth + 1);
        }
      }
    } catch {
      // Permission error or similar
    }
  }

  // Also check root for SKILL.md
  const rootSkillMd = join(dir, "SKILL.md");
  if (existsSync(rootSkillMd)) {
    const dirName = dir.split("/").pop() ?? "root";
    results.push({ skillId: dirName, path: rootSkillMd });
  }

  walk(dir, 0);
  return results;
}

function checkContentType(skillDir: string): ContentType {
  return {
    hasInstructions: true, // SKILL.md always present
    hasScripts: existsSync(join(skillDir, "scripts")),
    hasReferences: existsSync(join(skillDir, "references")),
    hasAssets: existsSync(join(skillDir, "assets")),
  };
}

function readScriptFiles(skillDir: string): string {
  const scriptsDir = join(skillDir, "scripts");
  if (!existsSync(scriptsDir)) return "";

  const content: string[] = [];
  try {
    const files = readdirSync(scriptsDir, { withFileTypes: true });
    for (const file of files) {
      if (file.isFile()) {
        try {
          content.push(readFileSync(join(scriptsDir, file.name), "utf-8"));
        } catch {
          // Skip unreadable files
        }
      }
    }
  } catch {
    // Skip unreadable dir
  }
  return content.join("\n");
}

export async function processRepos(skills: ScrapedSkill[]): Promise<RepoData[]> {
  const grouped = groupBySource(skills);
  const results: RepoData[] = [];

  console.log(`Processing ${grouped.size} unique repos...`);
  mkdirSync(REPOS_DIR, { recursive: true });
  mkdirSync(CLONE_DIR, { recursive: true });

  for (const [source, sourceSkills] of grouped) {
    console.log(`  Cloning ${source}...`);
    const cloneDir = cloneRepo(source);

    if (!cloneDir) {
      // Create minimal repo data from scraped info
      results.push({
        source,
        repoUrl: `https://github.com/${source}`,
        skills: sourceSkills.map((s) => ({
          skillId: s.skillId,
          parsed: {
            name: s.name,
            description: "",
            compatibility: null,
            license: null,
            allowedTools: [],
            metadata: {},
            body: "",
          },
          contentType: {
            hasInstructions: true,
            hasScripts: false,
            hasReferences: false,
            hasAssets: false,
          },
          dependencies: [],
        })),
      });
      continue;
    }

    const skillMdFiles = findSkillMdFiles(cloneDir);
    console.log(`  Found ${skillMdFiles.length} SKILL.md files`);

    const repoData: RepoData = {
      source,
      repoUrl: `https://github.com/${source}`,
      skills: [],
    };

    for (const { skillId, path: skillMdPath } of skillMdFiles) {
      try {
        const content = readFileSync(skillMdPath, "utf-8");
        const parsed = parseSkillMd(content);
        const skillDir = dirname(skillMdPath);
        const contentType = checkContentType(skillDir);

        // Detect dependencies from multiple sources
        const allDeps: Dependency[] = [];

        if (parsed.compatibility) {
          allDeps.push(...detectFromCompatibility(parsed.compatibility));
        }

        allDeps.push(...detectFromInstructions(parsed.body));

        if (contentType.hasScripts) {
          const scriptContent = readScriptFiles(skillDir);
          allDeps.push(...detectFromScripts(scriptContent));
        }

        repoData.skills.push({
          skillId,
          parsed,
          contentType,
          dependencies: deduplicateDeps(allDeps),
        });
      } catch (err) {
        console.error(`  Error processing ${skillId}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Add any scraped skills that weren't found as SKILL.md files
    const foundIds = new Set(repoData.skills.map((s) => s.skillId));
    for (const scraped of sourceSkills) {
      if (!foundIds.has(scraped.skillId)) {
        repoData.skills.push({
          skillId: scraped.skillId,
          parsed: {
            name: scraped.name,
            description: "",
            compatibility: null,
            license: null,
            allowedTools: [],
            metadata: {},
            body: "",
          },
          contentType: {
            hasInstructions: true,
            hasScripts: false,
            hasReferences: false,
            hasAssets: false,
          },
          dependencies: [],
        });
      }
    }

    results.push(repoData);

    // Save individual repo data
    const repoFile = join(REPOS_DIR, `${source.replace("/", "__")}.json`);
    writeFileSync(repoFile, JSON.stringify(repoData, null, 2));
  }

  // Cleanup clones
  try {
    rmSync(CLONE_DIR, { recursive: true, force: true });
  } catch {
    // Best effort cleanup
  }

  return results;
}

// Direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const inputFile = join(DATA_DIR, "skills-sh.json");
  if (!existsSync(inputFile)) {
    console.error("Run scrape-skills-sh first to generate skills-sh.json");
    process.exit(1);
  }
  const skills: ScrapedSkill[] = JSON.parse(readFileSync(inputFile, "utf-8"));
  await processRepos(skills);
  console.log("Done processing repos");
}

export default processRepos;
