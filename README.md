# skills-library

Enriched, searchable catalog of AI agent skills from [skills.sh](https://skills.sh).

Skills are the emerging standard for extending AI coding agents (Claude Code, Cursor, Codex, etc.) with reusable instructions, scripts, and references. **skills-library** solves discovery gaps in the current ecosystem:

- **Dependency visibility** — see which skills need Docker, Python, npm packages, or external services before installing
- **Content classification** — know if a skill is just instructions vs. has executable scripts, references, or assets
- **LLM-discoverable** — `/llms.txt`, static JSON API, and MCP server make the catalog accessible to AI agents
- **Searchable UI** — full-text search with advanced filters, categories, and sorting

## Quick Start

```bash
# Clone and install
git clone https://github.com/Zaz-OS/skills-library.git
cd skills-library
pnpm install

# Run the data pipeline (scrapes skills.sh, clones repos, enriches with GitHub data)
pnpm pipeline

# Start the dev server
pnpm dev:site
```

The site will be available at `http://localhost:4321`.

## Project Structure

```
skills-library/
├── types/          # Shared TypeScript interfaces (Skill, Dependency, etc.)
├── scripts/        # Data pipeline: scrape, parse, enrich, build catalog
├── site/           # Astro static site with search UI
├── mcp/            # MCP server for local stdio access by AI agents
├── mcp-worker/     # Cloudflare Worker MCP server (remote HTTP)
├── data/           # Generated catalog data (gitignored, built by pipeline)
└── .github/        # GitHub Actions for daily automated updates
```

## Commands

| Command | Description |
|---------|-------------|
| `pnpm pipeline` | Run full data pipeline (scrape + process + enrich + build) |
| `pnpm dev:site` | Start Astro dev server |
| `pnpm dev:mcp` | Start MCP server in dev mode (stdio) |
| `pnpm dev:mcp-worker` | Start MCP Worker dev server (HTTP) |
| `pnpm build` | Build everything (scripts + site + mcp) |

## Data Pipeline

The pipeline runs in 4 stages:

1. **Scrape** — extracts skill list from skills.sh (names, install counts, source repos)
2. **Process** — shallow-clones source repos, parses SKILL.md frontmatter, detects dependencies, classifies content
3. **Enrich** — fetches GitHub stars via API (with etag caching)
4. **Build** — merges all data into `skills.json`, `dependencies.json`, `llms.txt`, and search index

## Catalog Stats

| Metric | Count |
|--------|-------|
| Total skills | 5,959 |
| Source repos | 100 |
| Standalone (no deps) | 2,429 |
| With dependencies | 3,530 |
| With scripts | 442 |
| With references | 1,298 |

## API Endpoints

The static site exposes these endpoints:

- `/api/skills.json` — full catalog with all metadata
- `/api/deps.json` — dependency index grouped by type
- `/api/stats.json` — summary statistics
- `/llms.txt` — concise LLM-discoverable index
- `/llms-full.txt` — extended version with full descriptions
- `/mcp` — setup instructions for connecting AI agents to the MCP server

## MCP Server

The catalog is available to AI agents via MCP (Model Context Protocol). Two options:

### Remote (recommended)

Connect to the hosted MCP server — no local setup required:

```json
{
  "mcpServers": {
    "skills-library": {
      "type": "url",
      "url": "https://mcp.skills-library.com/mcp"
    }
  }
}
```

### Local (stdio)

Run the MCP server locally for development or offline use:

```json
{
  "mcpServers": {
    "skills-library": {
      "command": "node",
      "args": ["path/to/mcp/dist/index.js"]
    }
  }
}
```

**Tools available:** `search_skills`, `get_skill`, `list_by_dependency`, `list_standalone`, `get_dependency_tree`, `get_stats`

## Environment Variables

Copy `.env.example` to `.env`:

```bash
# GitHub personal access token — raises API rate limit from 60 to 5000 req/hr
# Create one at: https://github.com/settings/tokens (no scopes needed)
GITHUB_TOKEN=ghp_...
```

## Tech Stack

- **Astro 5** — static site generator
- **Tailwind CSS** — styling
- **Fuse.js** — client-side fuzzy search
- **MCP SDK** — Model Context Protocol server
- **gray-matter** — SKILL.md frontmatter parsing
- **Octokit** — GitHub API client
- **pnpm workspaces** — monorepo management

## License

MIT Open source. Maintained by [Zaz⚡️OS](https://www.zazos.com).
