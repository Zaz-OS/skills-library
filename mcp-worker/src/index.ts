import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import Fuse from "fuse.js";

// ── Types ────────────────────────────────────────────────────────────

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

// ── Global Cache (persists across requests in Worker isolate) ────────

const DATA_URL_BASE = "https://skills-library.com";

let cachedSkills: Skill[] | null = null;
let cachedDeps: DependencyIndex | null = null;
let cachedStats: CatalogStats | null = null;
let cachedFuse: Fuse<Skill> | null = null;

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${DATA_URL_BASE}/api/${path}`);
    if (res.ok) return (await res.json()) as T;
  } catch {
    // Fetch failed
  }
  return null;
}

async function getSkills(): Promise<Skill[]> {
  if (!cachedSkills) {
    cachedSkills = (await fetchJson<Skill[]>("skills.json")) ?? [];
  }
  return cachedSkills;
}

async function getDependencyIndex(): Promise<DependencyIndex> {
  if (!cachedDeps) {
    cachedDeps = (await fetchJson<DependencyIndex>("deps.json")) ?? {};
  }
  return cachedDeps;
}

async function getStats(): Promise<CatalogStats> {
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

async function getFuse(): Promise<Fuse<Skill>> {
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

async function searchSkills(
  query: string,
  options?: { standaloneOnly?: boolean; contentType?: string[] },
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

async function getSkillById(id: string): Promise<Skill | undefined> {
  const skills = await getSkills();
  return skills.find((s) => s.id === id);
}

async function listByDependency(
  dependency: string,
  type?: string,
): Promise<Skill[]> {
  const skills = await getSkills();
  return skills.filter((s) =>
    s.dependencies.some(
      (d) =>
        (d.name.includes(dependency) || d.org.includes(dependency)) &&
        (!type || d.type === type),
    ),
  );
}

async function listStandalone(
  sortBy: "installs" | "stars" | "name" = "installs",
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

// ── MCP Server Factory ──────────────────────────────────────────────

function createServer(): McpServer {
  const server = new McpServer({
    name: "skills-library",
    version: "0.1.0",
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
      const results = await searchSkills(args.query, {
        standaloneOnly: args.standalone_only,
        contentType: args.content_type,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              results.map((s) => ({
                id: s.id,
                name: s.name,
                description: s.description,
                installs: s.installs,
                stars: s.githubStars,
                standalone: s.standalone,
                dependencies: s.dependencies.map(
                  (d) => `${d.name} (${d.type})`,
                ),
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
      const skill = await getSkillById(args.id);
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
      const results = await listByDependency(args.dependency, args.type);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              results.map((s) => ({
                id: s.id,
                name: s.name,
                matchingDeps: s.dependencies.filter(
                  (d) =>
                    d.name.includes(args.dependency) ||
                    d.org.includes(args.dependency),
                ),
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
      const results = await listStandalone(args.sort_by);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              results.map((s) => ({
                id: s.id,
                name: s.name,
                description: s.description,
                installs: s.installs,
                stars: s.githubStars,
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
      const index = await getDependencyIndex();
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
      const stats = await getStats();
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(stats, null, 2) },
        ],
      };
    },
  );

  return server;
}

// ── Worker Entry ────────────────────────────────────────────────────

interface Env {}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const server = createServer();
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
} satisfies ExportedHandler<Env>;
