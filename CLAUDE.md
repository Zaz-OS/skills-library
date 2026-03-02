# skills-library

Enriched, searchable catalog of AI agent skills from skills.sh.

## Project Structure

- `types/` — Shared TypeScript interfaces (Skill, Dependency, etc.)
- `scripts/` — Data pipeline: scrape, parse, enrich, build catalog
- `site/` — Astro static site with search UI
- `mcp/` — MCP server for programmatic access (local stdio)
- `mcp-worker/` — Cloudflare Worker MCP server (remote HTTP)
- `data/` — Generated catalog data (gitignored on main)

## Monorepo

Uses pnpm workspaces. Run from root:
- `pnpm pipeline` — Run data pipeline
- `pnpm dev:site` — Astro dev server
- `pnpm dev:mcp` — MCP server dev (stdio)
- `pnpm dev:mcp-worker` — MCP Worker dev server (HTTP)

## Key Commands

- `pnpm --filter scripts start` — Run full pipeline
- `pnpm --filter site dev` — Start Astro dev server
- `pnpm --filter mcp dev` — Start MCP server
- `pnpm dev:mcp-worker` — Start MCP Worker dev server

## Conventions

- TypeScript with strict mode
- ES modules throughout
- Shared types imported from `../../types/index.ts` (relative paths)
