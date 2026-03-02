#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  searchSkills,
  getSkillById,
  listByDependency,
  listStandalone,
  getDependencyIndex,
  getStats,
} from "./data.js";

const server = new McpServer({
  name: "skills-library",
  version: "0.1.0",
});

server.tool(
  "search_skills",
  "Full-text search across AI agent skills. Returns matching skills with their descriptions, dependencies, and metadata.",
  {
    query: z.string().describe("Search query to match against skill names, descriptions, and dependencies"),
    standalone_only: z.boolean().optional().describe("If true, only return skills with no external dependencies"),
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
              dependencies: s.dependencies.map((d) => `${d.name} (${d.type})`),
            })),
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "get_skill",
  "Get full details of a specific AI agent skill by its ID.",
  {
    id: z.string().describe("Skill ID in format 'owner/repo/skill-name'"),
  },
  async (args) => {
    const skill = await getSkillById(args.id);
    if (!skill) {
      return {
        content: [{ type: "text" as const, text: `Skill not found: ${args.id}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(skill, null, 2) }],
    };
  }
);

server.tool(
  "list_by_dependency",
  "List AI agent skills that require a specific dependency (e.g., 'docker', 'python', 'jq').",
  {
    dependency: z.string().describe("Dependency name or organization to search for"),
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
                (d) => d.name.includes(args.dependency) || d.org.includes(args.dependency)
              ),
            })),
            null,
            2
          ),
        },
      ],
    };
  }
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
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "get_dependency_tree",
  "Get the full dependency index showing all dependencies grouped by type and which skills require them.",
  {},
  async () => {
    const index = await getDependencyIndex();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(index, null, 2) }],
    };
  }
);

server.tool(
  "get_stats",
  "Get summary statistics about the skills catalog.",
  {},
  async () => {
    const stats = await getStats();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(stats, null, 2) }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
