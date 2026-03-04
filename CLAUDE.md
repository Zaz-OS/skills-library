# skills-library

Enriched, searchable catalog of AI agent skills from skills.sh.

## Architecture

- **D1 Database**: Cloudflare D1 (SQLite on the edge) stores all skills + dependencies
- **Daily Pipeline**: Scrape skills.sh API → upsert to D1 (2 steps, ~3 min)
- **Weekly Enrichment**: Fetch SKILL.md + GitHub stars for un-enriched repos
- **Worker**: REST API + MCP tools, queries D1 directly (no Fuse.js)
- **Site**: Astro SSG, fetches from Worker API at build time + client-side search via API

## Project Structure

- `types/` — Shared TypeScript interfaces (Skill, SkillRow, Dependency, etc.)
- `scripts/` — Data pipeline: scrape + sync to D1, enrichment batch
- `site/` — Astro static site with search UI (fetches from Worker API)
- `mcp/` — MCP server for programmatic access (local stdio)
- `mcp-worker/` — Cloudflare Worker: REST API + MCP server + D1 queries
- `data/` — Scraped data cache (gitignored)

## Monorepo

Uses pnpm workspaces. Run from root:
- `pnpm pipeline` — Run data pipeline (scrape + D1 sync)
- `pnpm dev:site` — Astro dev server
- `pnpm dev:mcp` — MCP server dev (stdio)
- `pnpm dev:mcp-worker` — MCP Worker dev server (HTTP + local D1)

## Key Commands

- `pnpm --filter scripts start` — Run full pipeline (scrape + sync D1)
- `pnpm --filter scripts scrape` — Scrape skills.sh only
- `pnpm --filter scripts sync-d1` — Sync scraped data to D1 only
- `pnpm --filter scripts enrich` — Run enrichment batch
- `pnpm --filter site dev` — Start Astro dev server
- `pnpm --filter mcp dev` — Start MCP server
- `pnpm dev:mcp-worker` — Start MCP Worker dev server

## D1 Setup

```bash
# Create database (one-time)
cd mcp-worker && wrangler d1 create skills-library
# Update database_id in wrangler.jsonc

# Initialize schema
wrangler d1 execute skills-library --local --file=schema.sql   # local dev
wrangler d1 execute skills-library --remote --file=schema.sql  # production

# Seed local D1
pnpm --filter scripts start  # with CLOUDFLARE_* env vars
```

## Local Dev

```bash
pnpm dev:mcp-worker                                    # Worker on :8787 (local D1)
PUBLIC_API_URL=http://localhost:8787 pnpm dev:site      # Astro on :4321
```

## Environment Variables

- `CLOUDFLARE_API_TOKEN` — Cloudflare API token (needs D1 edit permission)
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account ID
- `D1_DATABASE_ID` — D1 database ID
- `GITHUB_TOKEN` — GitHub token (optional, raises rate limit)
- `PUBLIC_API_URL` — Worker API URL (defaults to https://mcp.skills-library.com)

## Conventions

- TypeScript with strict mode
- ES modules throughout
- Shared types imported from `../../types/index.ts` (relative paths)
- D1 columns use snake_case; TypeScript interfaces use camelCase
- SkillRow ↔ Skill conversion via helpers in types/index.ts
