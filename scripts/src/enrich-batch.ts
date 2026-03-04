import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkillMd } from "./utils/skill-parser.js";
import {
  detectFromCompatibility,
  detectFromInstructions,
  deduplicateDeps,
} from "./utils/dependency-detector.js";
import type { Dependency } from "../../types/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ───────────────────────────────────────────────────────────

const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const D1_DATABASE_ID = process.env.D1_DATABASE_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const BATCH_SIZE = Number(process.env.ENRICH_BATCH_SIZE) || 500;
const GITHUB_API = "https://api.github.com";
const RAW_GITHUB = "https://raw.githubusercontent.com";

// ── Technical keywords for non_dev classification ────────────────────

const TECHNICAL_KEYWORDS =
  /\b(api|sdk|cli|npm|pip|docker|kubernetes|k8s|terraform|devops|cicd|ci\/cd|backend|database|sql|nosql|graphql|grpc|microservice|deploy|git(?:hub|lab)?|aws|azure|gcloud|serverless|webpack|vite|eslint|prettier|jest|pytest|playwright|cypress|debug|compiler|runtime|binary|middleware|oauth|jwt|endpoint|webhook|localhost|daemon|container|ssh|ssl|tls|nginx|apache|redis|postgres|mysql|mongodb|kafka|elasticsearch|cron|bash|shell|powershell|regex|refactor|linting|typescript|javascript|python|rust|golang|kotlin|swift|flutter|react|nextjs|next\.js|vue|angular|svelte|nuxt|remix|astro|node\.js|deno|bun|express|fastapi|django|flask|rails|laravel|spring|supabase|prisma|drizzle|sequelize|mongoose|tailwindcss|sass|webpack|rollup|turbopack|storybook|nx|monorepo|ci|cd|yaml|json|xml|csv|protobuf|websocket|tcp|udp|http|rest|soap|rpc|ssr|ssg|hydration|jsx|tsx|component|hook|state.?management|routing|orm|migration|schema|query|index|cache|cdn|load.?balanc|proxy|gateway|queue|pub.?sub|event.?driven|hexagonal|clean.?arch|solid|design.?pattern|unit.?test|e2e|integration.?test|mock|stub|fixture|assertion|benchmark|profil|heap|stack|thread|async|promise|callback|observable|stream|buffer|pipe|stdin|stdout|stderr|env|dotenv|config|secret|token|credential|certificate|key.?pair|encrypt|decrypt|hash|salt|bcrypt|argon|crypto)\b/i;

// ── D1 HTTP API ──────────────────────────────────────────────────────

interface D1ApiResponse {
  success: boolean;
  errors: any[];
  result: any[];
}

async function queryD1(sql: string, params: any[] = []): Promise<D1ApiResponse> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
    },
  );
  if (!res.ok) throw new Error(`D1 API error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<D1ApiResponse>;
}

async function batchQueryD1(statements: { sql: string; params: any[] }[]): Promise<void> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(statements),
    },
  );
  if (!res.ok) throw new Error(`D1 batch error ${res.status}: ${await res.text()}`);
}

// ── GitHub API Helpers ───────────────────────────────────────────────

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "skills-library/0.1",
  };
  if (GITHUB_TOKEN) {
    headers.Authorization = `token ${GITHUB_TOKEN}`;
  }
  return headers;
}

interface TreeEntry {
  path: string;
  type: "blob" | "tree";
}

async function getRepoTree(source: string): Promise<TreeEntry[] | null> {
  const [owner, repo] = source.split("/");
  const url = `${GITHUB_API}/repos/${owner}/${repo}/git/trees/main?recursive=1`;

  const res = await fetch(url, { headers: githubHeaders() });
  if (res.status === 404) {
    // Try 'master' branch
    const res2 = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/git/trees/master?recursive=1`,
      { headers: githubHeaders() },
    );
    if (!res2.ok) return null;
    const data = await res2.json() as any;
    return data.tree ?? null;
  }
  if (!res.ok) return null;
  const data = await res.json() as any;
  return data.tree ?? null;
}

async function fetchFileContent(source: string, path: string, branch = "main"): Promise<string | null> {
  const url = `${RAW_GITHUB}/${source}/${branch}/${path}`;
  const res = await fetch(url, { headers: { "User-Agent": "skills-library/0.1" } });
  if (res.status === 404 && branch === "main") {
    return fetchFileContent(source, path, "master");
  }
  if (!res.ok) return null;
  return res.text();
}

async function fetchStarsBatch(sources: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!GITHUB_TOKEN || sources.length === 0) return result;

  // GraphQL batch query for stars (max 100 per query)
  for (let i = 0; i < sources.length; i += 100) {
    const batch = sources.slice(i, i + 100);
    const queries = batch.map((source, idx) => {
      const [owner, name] = source.split("/");
      return `r${idx}: repository(owner: "${owner}", name: "${name}") { stargazerCount }`;
    });

    const query = `query { ${queries.join("\n")} }`;

    try {
      const res = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          Authorization: `bearer ${GITHUB_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query }),
      });

      if (res.ok) {
        const data = await res.json() as any;
        batch.forEach((source, idx) => {
          const repoData = data?.data?.[`r${idx}`];
          if (repoData?.stargazerCount != null) {
            result.set(source, repoData.stargazerCount);
          }
        });
      }
    } catch {
      // Skip failed batch
    }

    // Rate limit delay
    if (i + 100 < sources.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return result;
}

// ── Enrichment Logic ─────────────────────────────────────────────────

async function enrichBatch(): Promise<void> {
  if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID || !D1_DATABASE_ID) {
    throw new Error("Missing env vars: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID");
  }

  console.log(`Enriching up to ${BATCH_SIZE} un-enriched repos...`);

  // 1. Get distinct repos that haven't been enriched yet
  const reposResult = await queryD1(
    "SELECT DISTINCT source FROM skills WHERE enriched = 0 LIMIT ?",
    [BATCH_SIZE],
  );
  const repos: string[] = (reposResult.result?.[0] as any)?.results?.map((r: any) => r.source) ?? [];

  if (repos.length === 0) {
    console.log("No un-enriched repos found. All caught up!");
    return;
  }

  console.log(`Found ${repos.length} repos to enrich`);

  // 2. Fetch stars for all repos
  const starMap = await fetchStarsBatch(repos);
  console.log(`Fetched stars for ${starMap.size} repos`);

  let enrichedCount = 0;
  let failedCount = 0;

  // 3. Process each repo
  for (const source of repos) {
    try {
      // Get repo tree
      const tree = await getRepoTree(source);
      if (!tree) {
        // Mark as enriched even if we can't access the repo (avoid retrying)
        await queryD1(
          "UPDATE skills SET enriched = 1, github_stars = ? WHERE source = ?",
          [starMap.get(source) ?? 0, source],
        );
        failedCount++;
        continue;
      }

      // Find SKILL.md files in the tree
      const skillMdFiles = tree.filter(
        (e) => e.type === "blob" && e.path.endsWith("SKILL.md"),
      );

      // Get skill IDs for this repo from D1
      const skillsResult = await queryD1(
        "SELECT id, skill_id FROM skills WHERE source = ?",
        [source],
      );
      const skillRows: { id: string; skill_id: string }[] =
        (skillsResult.result?.[0] as any)?.results ?? [];

      // Map skill_id to SKILL.md path
      const skillIdToPath = new Map<string, string>();
      for (const mdFile of skillMdFiles) {
        // Extract skill ID from path: "skills/skill-name/SKILL.md" → "skill-name"
        const parts = mdFile.path.split("/");
        const skillMdIdx = parts.indexOf("SKILL.md");
        if (skillMdIdx > 0) {
          const skillId = parts[skillMdIdx - 1];
          skillIdToPath.set(skillId, mdFile.path);
        } else if (mdFile.path === "SKILL.md") {
          // Root SKILL.md — matches any skill in this repo
          for (const row of skillRows) {
            if (!skillIdToPath.has(row.skill_id)) {
              skillIdToPath.set(row.skill_id, mdFile.path);
            }
          }
        }
      }

      // Detect content types from tree
      const hasScriptsDir = tree.some(
        (e) => e.type === "tree" && /\/scripts\/?$/i.test(e.path),
      );
      const hasReferencesDir = tree.some(
        (e) => e.type === "tree" && /\/references\/?$/i.test(e.path),
      );
      const hasAssetsDir = tree.some(
        (e) => e.type === "tree" && /\/assets\/?$/i.test(e.path),
      );

      const stars = starMap.get(source) ?? 0;
      const statements: { sql: string; params: any[] }[] = [];

      for (const skillRow of skillRows) {
        const mdPath = skillIdToPath.get(skillRow.skill_id);
        let description = "";
        let body = "";
        let deps: Dependency[] = [];
        let standalone = true;
        let compatibility: string | null = null;
        let license: string | null = null;
        let allowedTools: string[] = [];
        let metadata: Record<string, string> = {};

        if (mdPath) {
          const content = await fetchFileContent(source, mdPath);
          if (content) {
            const parsed = parseSkillMd(content);
            description = parsed.description;
            body = parsed.body;
            compatibility = parsed.compatibility;
            license = parsed.license;
            allowedTools = parsed.allowedTools;
            metadata = parsed.metadata;

            // Detect dependencies
            const allDeps: Dependency[] = [];
            if (parsed.compatibility) {
              allDeps.push(...detectFromCompatibility(parsed.compatibility));
            }
            if (parsed.body) {
              allDeps.push(...detectFromInstructions(parsed.body));
            }
            deps = deduplicateDeps(allDeps);
            standalone = deps.length === 0;
          }
        }

        // Compute non_dev
        const text = skillRow.skill_id + " " + description;
        const nonDev = standalone && !hasScriptsDir && !TECHNICAL_KEYWORDS.test(text) ? 1 : 0;

        // Update skill
        statements.push({
          sql: `UPDATE skills SET
            description = ?,
            body = ?,
            github_stars = ?,
            has_scripts = ?,
            has_references = ?,
            has_assets = ?,
            standalone = ?,
            compatibility = ?,
            license = ?,
            allowed_tools = ?,
            metadata = ?,
            non_dev = ?,
            enriched = 1
          WHERE id = ?`,
          params: [
            description,
            body,
            stars,
            hasScriptsDir ? 1 : 0,
            hasReferencesDir ? 1 : 0,
            hasAssetsDir ? 1 : 0,
            standalone ? 1 : 0,
            compatibility,
            license,
            JSON.stringify(allowedTools),
            JSON.stringify(metadata),
            nonDev,
            skillRow.id,
          ],
        });

        // Delete old dependencies for this skill
        statements.push({
          sql: "DELETE FROM dependencies WHERE skill_id = ?",
          params: [skillRow.id],
        });

        // Insert new dependencies
        for (const dep of deps) {
          statements.push({
            sql: "INSERT INTO dependencies (skill_id, type, org, name, detected_from) VALUES (?, ?, ?, ?, ?)",
            params: [skillRow.id, dep.type, dep.org, dep.name, dep.detectedFrom],
          });
        }
      }

      // Execute in batches of 100 (D1 limit)
      for (let i = 0; i < statements.length; i += 100) {
        const batch = statements.slice(i, i + 100);
        await batchQueryD1(batch);
      }

      enrichedCount++;
      if (enrichedCount % 50 === 0) {
        console.log(`  Enriched ${enrichedCount}/${repos.length} repos`);
      }

      // Rate limit: avoid hammering GitHub API
      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      console.error(`  Failed to enrich ${source}:`, err);
      failedCount++;
      // Mark as enriched to avoid retrying broken repos
      try {
        await queryD1(
          "UPDATE skills SET enriched = 1 WHERE source = ?",
          [source],
        );
      } catch {}
    }
  }

  console.log(`\nEnrichment complete:`);
  console.log(`  Enriched: ${enrichedCount}`);
  console.log(`  Failed: ${failedCount}`);
  console.log(`  Total repos processed: ${repos.length}`);
}

// ── Main ─────────────────────────────────────────────────────────────

enrichBatch().catch((err) => {
  console.error("Enrichment failed:", err);
  process.exit(1);
});
