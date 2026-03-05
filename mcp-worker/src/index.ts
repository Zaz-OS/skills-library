import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ── Types ────────────────────────────────────────────────────────────

interface SkillRow {
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

interface DependencyRow {
  id: number;
  skill_id: string;
  type: string;
  org: string;
  name: string;
  detected_from: string;
}

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
  body?: string;
}

interface Env {
  DB: D1Database;
  GITHUB_TOKEN?: string;
  ENRICH_BATCH_SIZE?: string;
}

// ── Row Conversion ───────────────────────────────────────────────────

function rowToSkill(row: SkillRow, deps?: DependencyRow[]): Skill {
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
      type: d.type,
      org: d.org,
      name: d.name,
      detectedFrom: d.detected_from,
    })),
    compatibility: row.compatibility,
    license: row.license,
    allowedTools: JSON.parse(row.allowed_tools || "[]"),
    metadata: JSON.parse(row.metadata || "{}"),
    body: row.body || undefined,
  };
}

function rowToSearchItem(row: SkillRow): object {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    source: row.source,
    skillId: row.skill_id,
    installs: row.installs,
    stars: row.github_stars,
    standalone: row.standalone === 1,
    nonDev: row.non_dev === 1,
    category: row.category,
    content: [
      row.has_scripts ? "scripts" : "",
      row.has_references ? "references" : "",
      row.has_assets ? "assets" : "",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

// ── D1 Query Helpers ─────────────────────────────────────────────────

async function searchSkillsD1(
  db: D1Database,
  query: string,
  options?: {
    limit?: number;
    page?: number;
    standalone?: boolean | null;
    category?: string | null;
    nonDev?: boolean | null;
  },
): Promise<{ skills: object[]; total: number }> {
  const limit = options?.limit ?? 24;
  const offset = ((options?.page ?? 1) - 1) * limit;

  // Build WHERE clauses for post-filters
  const filters: string[] = [];
  const filterParams: any[] = [];

  if (options?.standalone === true) {
    filters.push("s.standalone = 1");
  } else if (options?.standalone === false) {
    filters.push("s.standalone = 0");
  }

  if (options?.category) {
    filters.push("s.category = ?");
    filterParams.push(options.category);
  }

  if (options?.nonDev === true) {
    filters.push("s.non_dev = 1");
  }

  const whereClause = filters.length > 0 ? "AND " + filters.join(" AND ") : "";

  // Try FTS5 search first
  const ftsQuery = query
    .replace(/[^\w\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term}"*`)
    .join(" OR ");

  if (ftsQuery) {
    const sql = `
      SELECT s.* FROM skills_fts fts
      JOIN skills s ON s.rowid = fts.rowid
      WHERE skills_fts MATCH ?
      ${whereClause}
      ORDER BY fts.rank * -1 * (1 + log(s.installs + 1))
      LIMIT ? OFFSET ?
    `;

    const countSql = `
      SELECT COUNT(*) as total FROM skills_fts fts
      JOIN skills s ON s.rowid = fts.rowid
      WHERE skills_fts MATCH ?
      ${whereClause}
    `;

    try {
      const [results, countResult] = await Promise.all([
        db
          .prepare(sql)
          .bind(ftsQuery, ...filterParams, limit, offset)
          .all<SkillRow>(),
        db
          .prepare(countSql)
          .bind(ftsQuery, ...filterParams)
          .first<{ total: number }>(),
      ]);

      if (results.results.length > 0) {
        return {
          skills: results.results.map(rowToSearchItem),
          total: countResult?.total ?? 0,
        };
      }
    } catch {
      // FTS match syntax error — fall through to LIKE
    }
  }

  // Fallback: LIKE search
  const likePattern = `%${query}%`;
  const likeSql = `
    SELECT s.* FROM skills s
    WHERE (s.name LIKE ? OR s.description LIKE ? OR s.source LIKE ? OR s.skill_id LIKE ?)
    ${whereClause}
    ORDER BY s.installs DESC
    LIMIT ? OFFSET ?
  `;
  const likeCountSql = `
    SELECT COUNT(*) as total FROM skills s
    WHERE (s.name LIKE ? OR s.description LIKE ? OR s.source LIKE ? OR s.skill_id LIKE ?)
    ${whereClause}
  `;

  const [results, countResult] = await Promise.all([
    db
      .prepare(likeSql)
      .bind(likePattern, likePattern, likePattern, likePattern, ...filterParams, limit, offset)
      .all<SkillRow>(),
    db
      .prepare(likeCountSql)
      .bind(likePattern, likePattern, likePattern, likePattern, ...filterParams)
      .first<{ total: number }>(),
  ]);

  return {
    skills: results.results.map(rowToSearchItem),
    total: countResult?.total ?? 0,
  };
}

async function browseSkillsD1(
  db: D1Database,
  options?: {
    sort?: string;
    limit?: number;
    page?: number;
    standalone?: boolean | null;
    category?: string | null;
    nonDev?: boolean | null;
    minInstalls?: number;
  },
): Promise<{ skills: object[]; total: number }> {
  const limit = options?.limit ?? 24;
  const offset = ((options?.page ?? 1) - 1) * limit;
  const sort = options?.sort ?? "installs";
  const minInstalls = options?.minInstalls ?? 0;

  const filters: string[] = ["s.installs >= ?"];
  const filterParams: any[] = [minInstalls];

  if (options?.standalone === true) {
    filters.push("s.standalone = 1");
  } else if (options?.standalone === false) {
    filters.push("s.standalone = 0");
  }

  if (options?.category) {
    filters.push("s.category = ?");
    filterParams.push(options.category);
  }

  if (options?.nonDev === true) {
    filters.push("s.non_dev = 1");
  }

  const whereClause = "WHERE " + filters.join(" AND ");
  const orderClause =
    sort === "name"
      ? "ORDER BY s.name ASC"
      : sort === "stars"
        ? "ORDER BY s.github_stars DESC"
        : sort === "recent"
          ? "ORDER BY s.first_seen DESC"
          : "ORDER BY s.installs DESC";

  const sql = `SELECT s.* FROM skills s ${whereClause} ${orderClause} LIMIT ? OFFSET ?`;
  const countSql = `SELECT COUNT(*) as total FROM skills s ${whereClause}`;

  const [results, countResult] = await Promise.all([
    db.prepare(sql).bind(...filterParams, limit, offset).all<SkillRow>(),
    db
      .prepare(countSql)
      .bind(...filterParams)
      .first<{ total: number }>(),
  ]);

  return {
    skills: results.results.map(rowToSearchItem),
    total: countResult?.total ?? 0,
  };
}

async function getSkillByIdD1(
  db: D1Database,
  id: string,
): Promise<Skill | null> {
  const row = await db
    .prepare("SELECT * FROM skills WHERE id = ?")
    .bind(id)
    .first<SkillRow>();
  if (!row) return null;

  const deps = await db
    .prepare("SELECT * FROM dependencies WHERE skill_id = ?")
    .bind(id)
    .all<DependencyRow>();

  return rowToSkill(row, deps.results);
}

async function getStatsD1(
  db: D1Database,
): Promise<object> {
  const [total, repos, standalone, withDeps, withScripts, withRefs, withAssets] =
    await Promise.all([
      db.prepare("SELECT COUNT(*) as c FROM skills").first<{ c: number }>(),
      db
        .prepare("SELECT COUNT(DISTINCT source) as c FROM skills")
        .first<{ c: number }>(),
      db
        .prepare("SELECT COUNT(*) as c FROM skills WHERE standalone = 1")
        .first<{ c: number }>(),
      db
        .prepare("SELECT COUNT(*) as c FROM skills WHERE standalone = 0")
        .first<{ c: number }>(),
      db
        .prepare("SELECT COUNT(*) as c FROM skills WHERE has_scripts = 1")
        .first<{ c: number }>(),
      db
        .prepare("SELECT COUNT(*) as c FROM skills WHERE has_references = 1")
        .first<{ c: number }>(),
      db
        .prepare("SELECT COUNT(*) as c FROM skills WHERE has_assets = 1")
        .first<{ c: number }>(),
    ]);

  const depTypes = await db
    .prepare(
      "SELECT type, COUNT(*) as c FROM dependencies GROUP BY type",
    )
    .all<{ type: string; c: number }>();

  const byDepType: Record<string, number> = {};
  for (const row of depTypes.results) {
    byDepType[row.type] = row.c;
  }

  return {
    totalSkills: total?.c ?? 0,
    totalRepos: repos?.c ?? 0,
    standaloneCount: standalone?.c ?? 0,
    withDepsCount: withDeps?.c ?? 0,
    byContentType: {
      instructionsOnly:
        (total?.c ?? 0) -
        (withScripts?.c ?? 0) -
        (withRefs?.c ?? 0) -
        (withAssets?.c ?? 0),
      withScripts: withScripts?.c ?? 0,
      withReferences: withRefs?.c ?? 0,
      withAssets: withAssets?.c ?? 0,
    },
    byDependencyType: byDepType,
    lastUpdated: new Date().toISOString(),
  };
}

async function getCategoriesD1(
  db: D1Database,
): Promise<{ category: string; count: number }[]> {
  const result = await db
    .prepare(
      "SELECT category, COUNT(*) as count FROM skills WHERE category != '' GROUP BY category ORDER BY count DESC",
    )
    .all<{ category: string; count: number }>();
  return result.results;
}

// ── REST API Handler ─────────────────────────────────────────────────

function parseBoolean(val: string | null): boolean | null {
  if (val === "true" || val === "1") return true;
  if (val === "false" || val === "0") return false;
  return null;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=60",
    },
  });
}

async function handleRestApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  // GET /api/search?q=...&limit=24&page=1&standalone=...&category=...&nonDev=...
  if (path === "/api/search") {
    const query = url.searchParams.get("q") ?? "";
    if (!query) return jsonResponse({ skills: [], total: 0 });

    const result = await searchSkillsD1(env.DB, query, {
      limit: Math.min(Number(url.searchParams.get("limit")) || 24, 200),
      page: Number(url.searchParams.get("page")) || 1,
      standalone: parseBoolean(url.searchParams.get("standalone")),
      category: url.searchParams.get("category"),
      nonDev: parseBoolean(url.searchParams.get("nonDev")),
    });
    return jsonResponse(result);
  }

  // GET /api/browse?sort=installs&limit=24&page=1&category=...&standalone=...&nonDev=...&minInstalls=0
  if (path === "/api/browse") {
    const result = await browseSkillsD1(env.DB, {
      sort: url.searchParams.get("sort") ?? "installs",
      limit: Math.min(Number(url.searchParams.get("limit")) || 24, 200),
      page: Number(url.searchParams.get("page")) || 1,
      standalone: parseBoolean(url.searchParams.get("standalone")),
      category: url.searchParams.get("category"),
      nonDev: parseBoolean(url.searchParams.get("nonDev")),
      minInstalls: Number(url.searchParams.get("minInstalls")) || 0,
    });
    return jsonResponse(result);
  }

  // GET /api/skill/:source/:repo/:skillId (or /api/skill/source/repo/skillId)
  if (path.startsWith("/api/skill/")) {
    const id = path.slice("/api/skill/".length);
    if (!id) return jsonResponse({ error: "Missing skill ID" }, 400);

    const skill = await getSkillByIdD1(env.DB, id);
    if (!skill) return jsonResponse({ error: "Skill not found" }, 404);
    return jsonResponse(skill);
  }

  // GET /api/stats
  if (path === "/api/stats") {
    const cacheKey = new Request(url.toString(), request);
    const cache = caches.default;
    let response = await cache.match(cacheKey);
    if (response) return response;

    const stats = await getStatsD1(env.DB);
    response = jsonResponse(stats);
    response.headers.set("Cache-Control", "public, max-age=300");
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }

  // GET /api/enrichment — enrichment progress dashboard
  if (path === "/api/enrichment") {
    const [totals, recentRepos, topEnriched] = await Promise.all([
      env.DB.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN enriched = 1 THEN 1 ELSE 0 END) as enriched,
          SUM(CASE WHEN enriched = 1 AND description != '' THEN 1 ELSE 0 END) as with_description,
          SUM(CASE WHEN enriched = 1 AND body != '' THEN 1 ELSE 0 END) as with_body,
          SUM(CASE WHEN enriched = 1 AND github_stars > 0 THEN 1 ELSE 0 END) as with_stars,
          COUNT(DISTINCT source) as total_repos,
          COUNT(DISTINCT CASE WHEN enriched = 1 THEN source END) as enriched_repos
        FROM skills
      `).first<any>(),
      env.DB.prepare(`
        SELECT source, COUNT(*) as skill_count,
          MAX(description) as sample_desc
        FROM skills WHERE enriched = 1 AND description != ''
        GROUP BY source ORDER BY rowid DESC LIMIT 10
      `).all<any>(),
      env.DB.prepare(`
        SELECT id, name, description, github_stars, installs
        FROM skills WHERE enriched = 1 AND description != ''
        ORDER BY installs DESC LIMIT 10
      `).all<any>(),
    ]);

    const t = totals ?? {};
    const pct = t.total > 0 ? ((t.enriched / t.total) * 100).toFixed(1) : "0";
    const repoPct = t.total_repos > 0 ? ((t.enriched_repos / t.total_repos) * 100).toFixed(1) : "0";

    return jsonResponse({
      progress: {
        skills: { enriched: t.enriched ?? 0, total: t.total ?? 0, percent: `${pct}%` },
        repos: { enriched: t.enriched_repos ?? 0, total: t.total_repos ?? 0, percent: `${repoPct}%` },
      },
      quality: {
        withDescription: t.with_description ?? 0,
        withBody: t.with_body ?? 0,
        withStars: t.with_stars ?? 0,
      },
      recentlyEnriched: recentRepos.results.map((r: any) => ({
        source: r.source,
        skillCount: r.skill_count,
        sampleDescription: r.sample_desc?.slice(0, 120) || "",
      })),
      topEnriched: topEnriched.results.map((r: any) => ({
        id: r.id,
        name: r.name,
        description: r.description?.slice(0, 120) || "",
        stars: r.github_stars,
        installs: r.installs,
      })),
    });
  }

  // POST /api/enrich-now — manual enrichment trigger with detailed response
  if (path === "/api/enrich-now" && request.method === "POST") {
    const batchSize = Number(url.searchParams.get("batch") || env.ENRICH_BATCH_SIZE) || 100;
    const result = await enrichBatch(env.DB, env.GITHUB_TOKEN, batchSize);
    return jsonResponse(result);
  }

  // GET /api/categories
  if (path === "/api/categories") {
    const categories = await getCategoriesD1(env.DB);
    return jsonResponse(categories);
  }

  return null;
}

// ── llms.txt Handlers ────────────────────────────────────────────────

async function handleLlmsTxt(db: D1Database): Promise<Response> {
  const stats = (await getStatsD1(db)) as any;
  const text = `# skills-library

> Searchable catalog of ${stats.totalSkills} AI agent skills from skills.sh with dependency mapping and content classification.

## Skills Catalog
- [Search skills](/api/search?q=your+query): Full-text search across all skills
- [Browse skills](/api/browse?sort=installs&limit=24): Paginated browsing with filters
- [Categories](/api/categories): Skills grouped by category

## Documentation
- [About this project](/about): How skills-library works and how to contribute

## Optional
- [Extended catalog](/llms-full.txt): Full descriptions of all skills in plain text
`;
  return new Response(text, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

async function handleLlmsFullTxt(db: D1Database): Promise<Response> {
  const total = await db
    .prepare("SELECT COUNT(*) as c FROM skills")
    .first<{ c: number }>();

  const lines: string[] = [
    "# skills-library — Full Catalog",
    "",
    `> ${total?.c ?? 0} AI agent skills indexed from skills.sh`,
    "",
    "---",
    "",
  ];

  // Stream in batches of 500 to avoid memory issues
  let offset = 0;
  const batchSize = 500;
  while (true) {
    const batch = await db
      .prepare(
        "SELECT id, name, description, installs, github_stars, standalone, repo_url, has_scripts, has_references, has_assets FROM skills ORDER BY installs DESC LIMIT ? OFFSET ?",
      )
      .bind(batchSize, offset)
      .all<SkillRow>();

    if (batch.results.length === 0) break;

    for (const s of batch.results) {
      lines.push(`## ${s.name}`);
      lines.push(`- ID: ${s.id}`);
      lines.push(`- Installs: ${s.installs}`);
      lines.push(`- Stars: ${s.github_stars}`);
      lines.push(`- Standalone: ${s.standalone === 1 ? "yes" : "no"}`);
      if (s.description) lines.push(`- Description: ${s.description}`);
      const contentParts: string[] = [];
      if (s.has_scripts) contentParts.push("scripts");
      if (s.has_references) contentParts.push("references");
      if (s.has_assets) contentParts.push("assets");
      lines.push(
        contentParts.length > 0
          ? `- Content: instructions + ${contentParts.join(", ")}`
          : `- Content: instructions only`,
      );
      lines.push(`- Repo: ${s.repo_url}`);
      lines.push("");
    }

    offset += batchSize;
  }

  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

// ── MCP Server Factory ──────────────────────────────────────────────

function createServer(db: D1Database): McpServer {
  const server = new McpServer({
    name: "skills-library",
    version: "0.2.0",
  });

  server.tool(
    "search_skills",
    "Full-text search across AI agent skills. Returns matching skills with their descriptions, dependencies, and metadata.",
    {
      query: z
        .string()
        .describe(
          "Search query to match against skill names, descriptions, and dependencies",
        ),
      standalone_only: z
        .boolean()
        .optional()
        .describe(
          "If true, only return skills with no external dependencies",
        ),
      content_type: z
        .array(z.enum(["scripts", "references", "assets"]))
        .optional()
        .describe("Filter by content type"),
    },
    async (args) => {
      const result = await searchSkillsD1(db, args.query, {
        standalone: args.standalone_only || null,
        limit: 50,
      });

      // Post-filter by content type (not in D1 query for simplicity)
      let skills = result.skills as any[];
      if (args.content_type?.length) {
        skills = skills.filter((s: any) => {
          for (const ct of args.content_type!) {
            if (!s.content.includes(ct)) return false;
          }
          return true;
        });
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              skills.map((s: any) => ({
                id: s.id,
                name: s.name,
                description: s.description,
                installs: s.installs,
                stars: s.stars,
                standalone: s.standalone,
              })),
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "get_skill",
    "Get full details of a specific AI agent skill by its ID.",
    {
      id: z
        .string()
        .describe("Skill ID in format 'owner/repo/skill-name'"),
    },
    async (args) => {
      const skill = await getSkillByIdD1(db, args.id);
      if (!skill) {
        return {
          content: [
            { type: "text" as const, text: `Skill not found: ${args.id}` },
          ],
          isError: true,
        };
      }
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(skill, null, 2) },
        ],
      };
    },
  );

  server.tool(
    "list_by_dependency",
    "List AI agent skills that require a specific dependency (e.g., 'docker', 'python', 'jq').",
    {
      dependency: z
        .string()
        .describe("Dependency name or organization to search for"),
      type: z
        .enum(["npm", "pip", "brew", "system", "service", "other"])
        .optional()
        .describe("Filter by dependency type"),
    },
    async (args) => {
      let sql =
        "SELECT DISTINCT s.id, s.name, s.description, s.installs, s.github_stars FROM skills s JOIN dependencies d ON d.skill_id = s.id WHERE (d.name LIKE ? OR d.org LIKE ?)";
      const params: any[] = [
        `%${args.dependency}%`,
        `%${args.dependency}%`,
      ];
      if (args.type) {
        sql += " AND d.type = ?";
        params.push(args.type);
      }
      sql += " ORDER BY s.installs DESC LIMIT 50";

      const results = await db
        .prepare(sql)
        .bind(...params)
        .all<any>();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              results.results.map((s: any) => ({
                id: s.id,
                name: s.name,
                description: s.description,
                installs: s.installs,
                stars: s.github_stars,
              })),
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "list_standalone",
    "List all standalone AI agent skills (no external dependencies needed).",
    {
      sort_by: z
        .enum(["installs", "stars", "name"])
        .optional()
        .default("installs")
        .describe("Sort order for results"),
    },
    async (args) => {
      const orderClause =
        args.sort_by === "stars"
          ? "ORDER BY github_stars DESC"
          : args.sort_by === "name"
            ? "ORDER BY name ASC"
            : "ORDER BY installs DESC";

      const results = await db
        .prepare(
          `SELECT id, name, description, installs, github_stars FROM skills WHERE standalone = 1 ${orderClause} LIMIT 50`,
        )
        .all<any>();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              results.results.map((s: any) => ({
                id: s.id,
                name: s.name,
                description: s.description,
                installs: s.installs,
                stars: s.github_stars,
              })),
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "get_dependency_tree",
    "Get the full dependency index showing all dependencies grouped by type and which skills require them.",
    {},
    async () => {
      const deps = await db
        .prepare(
          "SELECT type, org, name, skill_id FROM dependencies ORDER BY type, name",
        )
        .all<DependencyRow>();

      const index: Record<
        string,
        Record<string, { skills: string[]; count: number }>
      > = {};
      for (const d of deps.results) {
        if (!index[d.type]) index[d.type] = {};
        const key = d.org !== d.name ? `${d.org}/${d.name}` : d.name;
        if (!index[d.type][key]) index[d.type][key] = { skills: [], count: 0 };
        index[d.type][key].skills.push(d.skill_id);
        index[d.type][key].count++;
      }

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(index, null, 2) },
        ],
      };
    },
  );

  server.tool(
    "get_stats",
    "Get summary statistics about the skills catalog.",
    {},
    async () => {
      const stats = await getStatsD1(db);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(stats, null, 2) },
        ],
      };
    },
  );

  return server;
}

// ── CORS Helper ──────────────────────────────────────────────────────

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, mcp-session-id",
    "Access-Control-Expose-Headers": "mcp-session-id",
  };
}

// ── Enrichment (Cron) ────────────────────────────────────────────────

const GITHUB_API = "https://api.github.com";
const RAW_GITHUB = "https://raw.githubusercontent.com";

const TECHNICAL_KEYWORDS =
  /\b(api|sdk|cli|npm|pip|docker|kubernetes|k8s|terraform|devops|cicd|ci\/cd|backend|database|sql|nosql|graphql|grpc|microservice|deploy|git(?:hub|lab)?|aws|azure|gcloud|serverless|webpack|vite|eslint|prettier|jest|pytest|playwright|cypress|debug|compiler|runtime|binary|middleware|oauth|jwt|endpoint|webhook|localhost|daemon|container|ssh|ssl|tls|nginx|apache|redis|postgres|mysql|mongodb|kafka|elasticsearch|cron|bash|shell|powershell|regex|refactor|linting|typescript|javascript|python|rust|golang|kotlin|swift|flutter|react|nextjs|next\.js|vue|angular|svelte|nuxt|remix|astro|node\.js|deno|bun|express|fastapi|django|flask|rails|laravel|spring|supabase|prisma|drizzle|sequelize|mongoose|tailwindcss|sass|rollup|turbopack|storybook|nx|monorepo|yaml|json|xml|csv|protobuf|websocket|tcp|udp|http|rest|soap|rpc|ssr|ssg|jsx|tsx|component|hook|state.?management|routing|orm|migration|schema|query|cache|cdn|load.?balanc|proxy|gateway|queue|pub.?sub|event.?driven|unit.?test|e2e|integration.?test|mock|stub|async|promise|callback|stream|buffer|pipe|env|dotenv|config|secret|token|credential|encrypt|decrypt|hash|crypto|solidity|blockchain|web3|logging|observability|tracing|terraform|ansible|helm|argo|istio)\b/i;

interface TreeEntry {
  path: string;
  type: "blob" | "tree";
}

function githubHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "skills-library-worker/0.2",
  };
  if (token) h.Authorization = `token ${token}`;
  return h;
}

async function getRepoTree(source: string, token?: string): Promise<{ tree: TreeEntry[] } | "rate_limited" | "not_found"> {
  const [owner, repo] = source.split("/");
  for (const branch of ["main", "master"]) {
    const res = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
      { headers: githubHeaders(token) },
    );
    if (res.ok) {
      const data = (await res.json()) as any;
      return { tree: data.tree ?? [] };
    }
    if (res.status === 403 || res.status === 429) return "rate_limited";
  }
  return "not_found";
}

async function fetchRawFile(source: string, path: string, branch = "main"): Promise<string | null> {
  const res = await fetch(`${RAW_GITHUB}/${source}/${branch}/${path}`, {
    headers: { "User-Agent": "skills-library-worker/0.2" },
  });
  if (res.status === 404 && branch === "main") {
    return fetchRawFile(source, path, "master");
  }
  return res.ok ? res.text() : null;
}

function parseSkillMdLight(content: string): { description: string; body: string; compatibility: string | null } {
  // Lightweight frontmatter parser (no gray-matter dep in Worker)
  let description = "";
  let compatibility: string | null = null;
  let body = content;

  if (content.startsWith("---")) {
    const endIdx = content.indexOf("---", 3);
    if (endIdx !== -1) {
      const frontmatter = content.slice(3, endIdx);
      body = content.slice(endIdx + 3).trim();

      for (const line of frontmatter.split("\n")) {
        const match = line.match(/^(\w+):\s*(.+)/);
        if (match) {
          const [, key, val] = match;
          const cleaned = val.replace(/^["']|["']$/g, "").trim();
          if (key === "description") description = cleaned;
          if (key === "compatibility") compatibility = cleaned;
        }
      }
    }
  }

  return { description, body, compatibility };
}

function detectDepsLight(text: string): { type: string; org: string; name: string }[] {
  const deps: { type: string; org: string; name: string }[] = [];
  const seen = new Set<string>();

  const patterns: [RegExp, string, string, string][] = [
    [/\bnpm\s+install\b/i, "npm", "npm", "npm"],
    [/\bnpx\s+/i, "npm", "npm", "npx"],
    [/\bpnpm\s+(add|install)\b/i, "npm", "pnpm", "pnpm"],
    [/\byarn\s+add\b/i, "npm", "yarn", "yarn"],
    [/\bbun\s+(add|install)\b/i, "npm", "bun", "bun"],
    [/\bpip3?\s+install\b/i, "pip", "pip", "pip"],
    [/\bpython3?\b/i, "pip", "python", "python"],
    [/\bbrew\s+install\b/i, "brew", "homebrew", "brew"],
    [/\bdocker\b/i, "service", "docker", "docker"],
    [/\bgcloud\b/i, "service", "google", "gcloud"],
    [/\baws\s+/i, "service", "aws", "aws-cli"],
    [/\bsupabase\b/i, "service", "supabase", "supabase"],
    [/\bfirebase\b/i, "service", "google", "firebase"],
    [/\bjq\b/, "system", "jq", "jq"],
    [/\bcurl\b/, "system", "curl", "curl"],
    [/\bffmpeg\b/i, "system", "ffmpeg", "ffmpeg"],
    [/\bredis\b/i, "service", "redis", "redis"],
    [/\bpostgres(ql)?\b/i, "service", "postgresql", "postgresql"],
  ];

  for (const [pattern, type, org, name] of patterns) {
    if (pattern.test(text) && !seen.has(`${type}:${name}`)) {
      seen.add(`${type}:${name}`);
      deps.push({ type, org, name });
    }
  }

  return deps;
}

async function enrichBatch(db: D1Database, token?: string, batchSize = 6): Promise<{ enriched: number; failed: number; skipped: number; errors: string[] }> {
  // Workers have a 50 subrequest limit. Each repo needs ~3-6 fetches (tree + SKILL.md files + stars).
  // Safe batch size: ~6 repos per invocation.
  const safeBatch = Math.min(batchSize, 6);

  const reposResult = await db
    .prepare("SELECT DISTINCT source FROM skills WHERE enriched = 0 ORDER BY installs DESC LIMIT ?")
    .bind(safeBatch)
    .all<{ source: string }>();

  const repos = reposResult.results.map((r) => r.source);
  if (repos.length === 0) return { enriched: 0, failed: 0, skipped: 0, errors: [] };

  let enriched = 0;
  let failed = 0;
  let skipped = 0;
  const errors: string[] = [];
  let subrequestsUsed = 0;

  for (const source of repos) {
    // Stop before hitting the 50 subrequest limit (leave margin)
    if (subrequestsUsed > 40) {
      errors.push(`Stopping at ${source}: approaching subrequest limit (${subrequestsUsed} used)`);
      break;
    }

    try {
      const treeResult = await getRepoTree(source, token);
      subrequestsUsed += 2; // may try main + master
      if (treeResult === "rate_limited") {
        const msg = `Rate limited at repo ${source}, stopping batch`;
        console.log(msg);
        errors.push(msg);
        break;
      }
      if (treeResult === "not_found") {
        await db.prepare("UPDATE skills SET enriched = 1 WHERE source = ?").bind(source).run();
        skipped++;
        continue;
      }

      const tree = treeResult.tree;

      // Find SKILL.md files
      const skillMdFiles = tree.filter((e) => e.type === "blob" && e.path.endsWith("SKILL.md"));
      const hasScriptsDir = tree.some((e) => e.type === "tree" && /\/scripts\/?$/i.test(e.path));
      const hasRefsDir = tree.some((e) => e.type === "tree" && /\/references\/?$/i.test(e.path));
      const hasAssetsDir = tree.some((e) => e.type === "tree" && /\/assets\/?$/i.test(e.path));

      // Get skills for this repo
      const skillRows = await db
        .prepare("SELECT id, skill_id FROM skills WHERE source = ?")
        .bind(source)
        .all<{ id: string; skill_id: string }>();

      // Map skill_id → SKILL.md path
      const skillIdToPath = new Map<string, string>();
      for (const md of skillMdFiles) {
        const parts = md.path.split("/");
        const idx = parts.indexOf("SKILL.md");
        if (idx > 0) {
          skillIdToPath.set(parts[idx - 1], md.path);
        } else if (md.path === "SKILL.md") {
          for (const row of skillRows.results) {
            if (!skillIdToPath.has(row.skill_id)) skillIdToPath.set(row.skill_id, md.path);
          }
        }
      }

      // Fetch stars (1 subrequest)
      let stars = 0;
      if (token && subrequestsUsed < 45) {
        try {
          const [owner, name] = source.split("/");
          const gqlRes = await fetch("https://api.github.com/graphql", {
            method: "POST",
            headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ query: `query { repository(owner: "${owner}", name: "${name}") { stargazerCount } }` }),
          });
          subrequestsUsed++;
          if (gqlRes.ok) {
            const gql = (await gqlRes.json()) as any;
            stars = gql?.data?.repository?.stargazerCount ?? 0;
          }
        } catch {}
      }

      // Fetch SKILL.md files — limit to avoid hitting subrequest cap
      const uniquePaths = [...new Set(skillIdToPath.values())];
      const mdContents = new Map<string, string>();
      for (const mdPath of uniquePaths) {
        if (subrequestsUsed >= 48) break;
        const content = await fetchRawFile(source, mdPath);
        subrequestsUsed += 2; // may try main + master fallback
        if (content) mdContents.set(mdPath, content);
      }

      // Process each skill
      for (const row of skillRows.results) {
        const mdPath = skillIdToPath.get(row.skill_id);
        let description = "";
        let body = "";
        let deps: { type: string; org: string; name: string }[] = [];
        let standalone = true;

        if (mdPath && mdContents.has(mdPath)) {
          const parsed = parseSkillMdLight(mdContents.get(mdPath)!);
          description = parsed.description;
          body = parsed.body;

          const allText = (parsed.compatibility || "") + " " + parsed.body;
          deps = detectDepsLight(allText);
          standalone = deps.length === 0;
        }

        const text = row.skill_id + " " + description;
        const nonDev = standalone && !hasScriptsDir && !TECHNICAL_KEYWORDS.test(text) ? 1 : 0;

        await db
          .prepare(
            `UPDATE skills SET description=?, body=?, github_stars=?, has_scripts=?, has_references=?, has_assets=?, standalone=?, non_dev=?, enriched=1 WHERE id=?`,
          )
          .bind(description, body, stars, hasScriptsDir ? 1 : 0, hasRefsDir ? 1 : 0, hasAssetsDir ? 1 : 0, standalone ? 1 : 0, nonDev, row.id)
          .run();

        // Delete old deps + insert new
        await db.prepare("DELETE FROM dependencies WHERE skill_id = ?").bind(row.id).run();
        for (const dep of deps) {
          await db
            .prepare("INSERT INTO dependencies (skill_id, type, org, name, detected_from) VALUES (?, ?, ?, ?, 'instructions')")
            .bind(row.id, dep.type, dep.org, dep.name)
            .run();
        }
      }

      enriched++;
    } catch (err) {
      const msg = `Error enriching ${source}: ${err}`;
      console.log(msg);
      errors.push(msg);
      // Mark as enriched to avoid blocking the queue
      await db.prepare("UPDATE skills SET enriched = 1 WHERE source = ?").bind(source).run();
      failed++;
    }
  }

  return { enriched, failed, skipped, errors };
}

// ── Worker Entry ────────────────────────────────────────────────────

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // REST API
    if (url.pathname.startsWith("/api/")) {
      const apiResponse = await handleRestApi(request, env, ctx);
      if (apiResponse) return apiResponse;
      return jsonResponse({ error: "Not found" }, 404);
    }

    // llms.txt
    if (url.pathname === "/llms.txt") {
      return handleLlmsTxt(env.DB);
    }
    if (url.pathname === "/llms-full.txt") {
      return handleLlmsFullTxt(env.DB);
    }

    // MCP handler
    const server = createServer(env.DB);
    const handler = createMcpHandler(server, {
      route: "/mcp",
      corsOptions: {
        origin: "*",
        methods: "GET, POST, DELETE, OPTIONS",
        headers: "Content-Type, Authorization, mcp-session-id",
        exposeHeaders: "mcp-session-id",
      },
    });
    return handler(request, env, ctx);
  },

  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const batchSize = Number(env.ENRICH_BATCH_SIZE) || 20;
    const result = await enrichBatch(env.DB, env.GITHUB_TOKEN, batchSize);
    console.log(`Enrichment cron: ${result.enriched} enriched, ${result.failed} failed, ${result.skipped} skipped`);
    if (result.errors.length > 0) console.log(`Errors: ${result.errors.join("; ")}`);
  },
} satisfies ExportedHandler<Env>;
