import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { GitHubMeta, RepoData } from "../../types/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "../../data/raw");
const META_FILE = join(DATA_DIR, "github-meta.json");

function loadExistingMeta(): GitHubMeta {
  try {
    if (existsSync(META_FILE)) {
      return JSON.parse(readFileSync(META_FILE, "utf-8"));
    }
  } catch {
    // Ignore parse errors
  }
  return {};
}

async function fetchStars(
  repo: string,
  existingEtag?: string
): Promise<{ stars: number; etag?: string } | null> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "skills-library/0.1",
  };

  // Use GitHub token if available
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  // Use conditional request if we have an etag
  if (existingEtag) {
    headers["If-None-Match"] = existingEtag;
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}`, { headers });

    if (res.status === 304) {
      // Not modified — existing data is still valid
      return null;
    }

    if (res.status === 403) {
      console.warn(`  Rate limited for ${repo}`);
      return null;
    }

    if (!res.ok) {
      console.warn(`  GitHub API error for ${repo}: ${res.status}`);
      return null;
    }

    const data = (await res.json()) as { stargazers_count: number };
    const etag = res.headers.get("etag") ?? undefined;

    return { stars: data.stargazers_count, etag };
  } catch (err) {
    console.warn(`  Failed to fetch ${repo}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

export async function enrichWithGithub(repos: RepoData[]): Promise<GitHubMeta> {
  const meta = loadExistingMeta();
  const uniqueRepos = [...new Set(repos.map((r) => r.source))];

  console.log(`Enriching ${uniqueRepos.length} repos with GitHub data...`);

  // Rate limit: process sequentially with small delay
  for (const repo of uniqueRepos) {
    const existing = meta[repo];
    console.log(`  Fetching stars for ${repo}...`);

    const result = await fetchStars(repo, existing?.etag);

    if (result) {
      meta[repo] = {
        stars: result.stars,
        etag: result.etag,
        fetchedAt: new Date().toISOString(),
      };
      console.log(`    ${result.stars} stars`);
    } else if (existing) {
      console.log(`    Using cached: ${existing.stars} stars`);
    } else {
      meta[repo] = { stars: 0, fetchedAt: new Date().toISOString() };
      console.log(`    No data available`);
    }

    // Small delay to avoid rate limiting
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
  console.log(`Saved GitHub metadata to ${META_FILE}`);

  return meta;
}

// Direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const reposDir = join(DATA_DIR, "repos");
  if (!existsSync(reposDir)) {
    console.error("Run process-repos first to generate repo data");
    process.exit(1);
  }

  const { readdirSync } = await import("node:fs");
  const files = readdirSync(reposDir).filter((f) => f.endsWith(".json"));
  const repos: RepoData[] = files.map((f) =>
    JSON.parse(readFileSync(join(reposDir, f), "utf-8"))
  );

  await enrichWithGithub(repos);
  console.log("Done enriching");
}

export default enrichWithGithub;
