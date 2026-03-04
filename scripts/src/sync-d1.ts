import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScrapedSkill } from "../../types/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "../../data/raw");

// ── Category + NonDev Classification ─────────────────────────────────

const CATEGORY_PATTERNS: [string, RegExp][] = [
  ["design", /design|ui[/-]|ux|layout|style|css|tailwind|figma|frontend|web.?design|visual|theme/i],
  ["writing", /writ|content(?!.?type)|copy(?!right)|blog|article|document|markdown|readme|text|editor|draft|prose|grammar/i],
  ["marketing", /market|seo|social|email.?(sequence|campaign|market)|campaign|brand|growth|funnel|pricing|audience|lead|advertis|landing.?page|conversion/i],
  ["media", /image.?gen|video.?gen|photo|media|canvas|animation|gif|art(?!i)|illustra|render|dalle|flux|midjourney|stable.?diff/i],
  ["data", /data.?analy|spreadsheet|chart|report|monitor|dashboard|metric|visualiz|csv|excel|google.?sheet|bi\b|analytics/i],
  ["productivity", /brainstorm|plan(?!e)|organiz|workflow|automat|schedul|template|todo|productiv|project.?manag|notion|task/i],
];

const TECHNICAL_KEYWORDS =
  /\b(api|sdk|cli|npm|pip|docker|kubernetes|k8s|terraform|devops|cicd|ci\/cd|backend|database|sql|nosql|graphql|grpc|microservice|deploy|git(?:hub|lab)?|aws|azure|gcloud|serverless|webpack|vite|eslint|prettier|jest|pytest|playwright|cypress|debug|compiler|runtime|binary|middleware|oauth|jwt|endpoint|webhook|localhost|daemon|container|ssh|ssl|tls|nginx|apache|redis|postgres|mysql|mongodb|kafka|elasticsearch|cron|bash|shell|powershell|regex|refactor|linting|typescript|javascript|python|rust|golang|kotlin|swift|flutter|react|nextjs|next\.js|vue|angular|svelte|nuxt|remix|astro|node\.js|deno|bun|express|fastapi|django|flask|rails|laravel|spring|supabase|prisma|drizzle|sequelize|mongoose|tailwindcss|sass|webpack|rollup|turbopack|storybook|nx|monorepo|ci|cd|yaml|json|xml|csv|protobuf|websocket|tcp|udp|http|rest|soap|rpc|ssr|ssg|hydration|jsx|tsx|component|hook|state.?management|routing|orm|migration|schema|query|index|cache|cdn|load.?balanc|proxy|gateway|queue|pub.?sub|event.?driven|hexagonal|clean.?arch|solid|design.?pattern|unit.?test|e2e|integration.?test|mock|stub|fixture|assertion|benchmark|profil|heap|stack|thread|async|promise|callback|observable|stream|buffer|pipe|stdin|stdout|stderr|env|dotenv|config|secret|token|credential|certificate|key.?pair|encrypt|decrypt|hash|salt|bcrypt|argon|crypto)\b/i;

function classifyCategory(name: string): string {
  const text = name;
  for (const [cat, pattern] of CATEGORY_PATTERNS) {
    if (pattern.test(text)) return cat;
  }
  return "";
}

function isNonDev(name: string, standalone: boolean): boolean {
  if (!standalone) return false;
  return !TECHNICAL_KEYWORDS.test(name);
}

// ── D1 HTTP API ──────────────────────────────────────────────────────

const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const D1_DATABASE_ID = process.env.D1_DATABASE_ID;

interface D1ApiResponse {
  success: boolean;
  errors: any[];
  result: any[];
}

async function queryD1(sql: string, params: any[] = []): Promise<D1ApiResponse> {
  if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID || !D1_DATABASE_ID) {
    throw new Error("Missing env vars: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID");
  }

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

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`D1 API error ${res.status}: ${text}`);
  }

  return res.json() as Promise<D1ApiResponse>;
}

// ── Sync Logic ───────────────────────────────────────────────────────

function escapeSQL(val: string): string {
  return val.replace(/'/g, "''");
}

export async function syncToD1(skills: ScrapedSkill[]): Promise<void> {
  console.log(`Syncing ${skills.length} skills to D1...`);
  const now = new Date().toISOString();

  // D1 HTTP API only accepts a single SQL statement per request.
  // Build multi-row INSERT statements to batch efficiently.
  const BATCH_SIZE = 50; // Keep SQL size reasonable
  let synced = 0;

  for (let i = 0; i < skills.length; i += BATCH_SIZE) {
    const batch = skills.slice(i, i + BATCH_SIZE);

    const valueRows = batch.map((s) => {
      const id = `${s.source}/${s.skillId}`;
      const category = classifyCategory(s.name);
      const nonDev = isNonDev(s.name, true) ? 1 : 0;

      return `('${escapeSQL(id)}', '${escapeSQL(s.name)}', '${escapeSQL(s.source)}', '${escapeSQL(s.skillId)}', ${s.installs}, 'https://github.com/${escapeSQL(s.source)}', '${now}', '${now}', '${category}', ${nonDev})`;
    });

    const sql = `INSERT INTO skills (id, name, source, skill_id, installs, repo_url, first_seen, last_updated, category, non_dev)
      VALUES ${valueRows.join(",\n        ")}
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,
        installs=excluded.installs,
        last_updated=excluded.last_updated,
        category=excluded.category,
        non_dev=CASE WHEN skills.enriched = 1 THEN skills.non_dev ELSE excluded.non_dev END`;

    await queryD1(sql);
    synced += batch.length;
    if (synced % 1000 === 0 || synced === skills.length) {
      console.log(`  Synced ${synced}/${skills.length} skills`);
    }
  }

  console.log(`D1 sync complete: ${synced} skills upserted`);
}

// ── Direct Execution ─────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const inputFile = join(DATA_DIR, "skills-sh.json");
  if (!existsSync(inputFile)) {
    console.error(`Input file not found: ${inputFile}`);
    console.error("Run 'pnpm --filter scripts scrape' first");
    process.exit(1);
  }

  const skills: ScrapedSkill[] = JSON.parse(readFileSync(inputFile, "utf-8"));
  await syncToD1(skills);
}
