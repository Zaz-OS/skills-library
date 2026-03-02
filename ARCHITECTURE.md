# Architecture

## Overview

skills-library is a monorepo with 3 packages that form a pipeline-to-presentation architecture:

```
┌─────────────────────────────────────────────────────────┐
│                  Data Pipeline (scripts/)                │
│                                                         │
│  1. Scrape skills.sh HTML → skill list + installs       │
│  2. Clone source repos → parse SKILL.md files           │
│  3. Enrich via GitHub API → star counts                 │
│  4. Build → JSON catalog + llms.txt + search index      │
│                                                         │
└───────────────────────┬─────────────────────────────────┘
                        │
          ┌─────────────┼──────────────────────────┐
          ▼             ▼                          ▼
   ┌────────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐
   │ Astro Site │ │ llms.txt │ │ MCP      │ │ MCP Worker    │
   │ (search UI)│ │ + JSON   │ │ (stdio)  │ │ (CF Worker)   │
   │ Static     │ │ static   │ │ local    │ │ remote HTTP   │
   └────────────┘ └──────────┘ └──────────┘ └───────────────┘
```

## Data Model

Defined in `types/index.ts`. Core interfaces:

```typescript
Skill {
  id, name, description, source, skillId,
  installs, githubStars, repoUrl, firstSeen, lastUpdated,
  contentType: { hasInstructions, hasScripts, hasReferences, hasAssets },
  standalone: boolean,
  dependencies: Dependency[],
  compatibility, license, allowedTools, metadata
}

Dependency {
  type: "npm" | "pip" | "brew" | "system" | "service" | "other",
  org: string,
  name: string,
  detectedFrom: "compatibility" | "instructions" | "scripts"
}
```

## Data Pipeline (`scripts/src/`)

### 1. `scrape-skills-sh.ts`

Extracts the skill list from skills.sh HTML page. Uses multiple fallback strategies:
- Parses RSC (React Server Components) JSON payload
- Falls back to `__NEXT_DATA__` payload
- Regex extraction from escaped/unescaped JSON
- Final fallback: `npx skills find <category>` for 30+ categories

**Output:** `data/raw/skills-sh.json` — array of `ScrapedSkill` (source, skillId, name, installs)

### 2. `process-repos.ts`

For each unique source repository found in scraped data:
- Shallow clones from GitHub (sparse checkout of `skills/` dir only)
- Finds all SKILL.md files up to 5 levels deep
- Parses YAML frontmatter with `gray-matter` (`utils/skill-parser.ts`)
- Detects dependencies from compatibility field, instructions body, and script files (`utils/dependency-detector.ts`)
- Classifies content type by checking for scripts/, references/, assets/ directories
- Cleans up cloned repos after processing

**Output:** `data/raw/repos/<owner>__<repo>.json` — one file per repo with parsed skills

### 3. `enrich.ts`

Fetches GitHub API data for each unique repository:
- Uses conditional requests with ETags to minimize API calls
- Supports `GITHUB_TOKEN` env var for higher rate limits (5000 req/hr vs 60)
- Processes sequentially with 100ms delays

**Output:** `data/raw/github-meta.json` — star counts and etags per repo

### 4. `build-catalog.ts`

Merges all data sources:
- Primary: repo data (parsed SKILL.md + dependencies + content classification)
- Backfill: scraped skills not found in repos (minimal records)
- Preserves historical data (firstSeen from previous runs)

**Outputs:**
| File | Description |
|------|-------------|
| `data/skills.json` (6.9MB) | Full catalog |
| `data/dependencies.json` (687KB) | Index grouped by dependency type |
| `data/stats.json` | Summary statistics |
| `data/search-index.json` (2.8MB) | Optimized for Fuse.js |
| `data/llms.txt` | Concise LLM-discoverable index |
| `data/llms-full.txt` (2.7MB) | Full descriptions in plain text |

### Dependency Detector (`utils/dependency-detector.ts`)

Regex-based detection with 50+ patterns covering:
- **npm:** npm, npx, pnpm, yarn, bun + package name extraction
- **Python:** pip, pip3, pipx, uv
- **Brew:** homebrew
- **System:** apt, jq, curl, wget, git, etc.
- **Services:** Docker, Kubernetes, AWS, Azure, GCP, Vercel, Supabase, Firebase, etc.

Detects from 3 sources: compatibility field, instruction body, and script files. Deduplicates across all.

## Static Site (`site/`)

Astro 5 static site with Tailwind CSS and Fuse.js for search.

### Pages

- **`pages/index.astro`** — main browsing page with categories, search, and advanced filters
  - 15+ skill categories with pattern-based matching (design, writing, marketing, dev, etc.)
  - Curated "picks" per category
  - Stats display (total skills, repos, standalone count)
  - Loads `data/skills.json` at build time (SSG)

- **`pages/skill/[...id].astro`** — individual skill detail page
  - Full SKILL.md content rendered at build time with `marked`
  - Loads markdown bodies from `data/raw/repos/*.json` during getStaticPaths()
  - Dependency list, content type breakdown, badges for installs and stars
  - 5,926 of 5,957 skills have pre-rendered content

### Components

| Component | Purpose |
|-----------|---------|
| `SearchBar.astro` | Full-text fuzzy search with Fuse.js |
| `FilterPanel.astro` | Dependency and content type filters |
| `SkillCard.astro` | Skill summary card (name, description, installs, stars) |
| `DependencyTree.astro` | Dependency relationship visualization |

### Advanced Filters (index.astro)

Airbnb-style filter sidebar with:
- **Tri-state pills:** off -> include (green) -> exclude (red, strikethrough)
- **Sections:** For you, What's included, Setup needs, Category, Popularity
- **Active filter chips** between toolbar and grid with individual remove and "Clear all"
- **Mobile drawer** that slides up from bottom with "Show N results"
- **Filter engine:** AND logic across filter groups, OR within categories

### Build Process

`site/scripts/copy-data.js` copies generated data from `data/` to `site/public/`:
- `skills.json` -> `public/api/skills.json`
- `dependencies.json` -> `public/api/deps.json`
- `stats.json` -> `public/api/stats.json`
- `search-index.json` -> `public/api/search-index.json`
- `llms.txt` and `llms-full.txt` -> root of `public/`

### Design System

Custom Tailwind theme with:
- **Sand palette** (50-950): warm neutral tones
- **Accents:** Coral, Sky, Sage, Plum, Gold, Rose
- **Fonts:** Source Serif 4 (display), DM Sans (body), JetBrains Mono (code)

## MCP Server (`mcp/`)

TypeScript MCP server using `@modelcontextprotocol/sdk` for programmatic access by AI agents.

### Tools

| Tool | Parameters | Description |
|------|-----------|-------------|
| `search_skills` | query, standalone_only?, content_type? | Full-text search across skills |
| `get_skill` | id | Get full details of a specific skill |
| `list_by_dependency` | dependency, type? | List skills requiring a specific dependency |
| `list_standalone` | sort_by? | List all standalone skills |
| `get_dependency_tree` | — | Get the full dependency index |
| `get_stats` | — | Get catalog summary statistics |

### Data Loading (`src/data.ts`)

- Tries local `data/` files first (dev/local)
- Falls back to remote fetch from deployed static site
- Caches in memory after first load
- Uses Fuse.js for fuzzy search with weighted fields

### Transport

Supports stdio (for local Claude Code integration) and streamable HTTP (for remote).

## MCP Worker (`mcp-worker/`)

Cloudflare Worker that exposes the same MCP tools as the local server, but over Streamable HTTP for remote access by AI agents.

- Built with Cloudflare's `agents` package and `createMcpHandler`
- Stateless — creates a fresh `McpServer` per request
- Fetches catalog data from the deployed site's JSON API (`skills-library.com/api/`)
- Caches skills, dependencies, and stats in Worker isolate globals (persists across requests within the same isolate)
- Custom domain: `mcp.skills-library.com`

## CI/CD (`.github/workflows/update-catalog.yml`)

GitHub Actions workflow:
- **Trigger:** Daily at 06:00 UTC + manual workflow_dispatch
- **Steps:**
  1. Checkout code
  2. Setup Node.js 22 + pnpm 10
  3. Restore previous data from `data` branch
  4. Run full pipeline
  5. Build Astro site
  6. Deploy MCP Worker to Cloudflare
  7. Commit updated data to `data` branch
  8. Deploy to GitHub Pages

**Branch strategy:** `main` has source code only, `data` branch stores generated catalog files.

---

## What's Missing / TODO

### High Priority

- [x] ~~**Deploy to Cloudflare Pages**~~ — deployed via GitHub Pages with custom domain. MCP Worker deployed to Cloudflare Workers at `mcp.skills-library.com`.

- [x] ~~**`data/` not in .gitignore**~~ — added to `.gitignore`.

- [ ] **GitHub Actions workflow untested** — the `update-catalog.yml` workflow exists but has never been triggered. Needs manual testing with `workflow_dispatch` to verify the pipeline runs, data branch is updated, and site deploys correctly.

- [ ] **MCP server not published** — the local MCP server works but is not published to npm. The remote MCP Worker is the primary access method now, but publishing to npm would allow `npx skills-library-mcp` for offline use.

### Medium Priority

- [ ] **No tests** — zero test coverage across all packages. At minimum, the dependency detector and skill parser should have unit tests since they use complex regex patterns.

- [ ] **Search index not used** — `data/search-index.json` is generated but the site loads the full `skills.json` (6.9MB) for Fuse.js search. Should use the optimized search index instead.

- [ ] **Scraper fragility** — `scrape-skills-sh.ts` relies on parsing skills.sh HTML structure (RSC payloads, Next.js data). Any frontend change on skills.sh can break the scraper. The multiple fallback strategies help but should be monitored.

- [ ] **No error reporting** — pipeline failures are silent. Should have notification (GitHub Actions alerts, or at minimum a `data/pipeline-log.json` with run status).

### Low Priority

- [ ] **No pagination** — the browse view loads all 5,959 skills client-side. Works now but may need pagination or virtual scrolling as the catalog grows.

- [ ] **No skill content in skills.json** — the SKILL.md body is loaded from raw repo data at site build time but not included in the main `skills.json` catalog. The MCP server and API consumers don't have access to skill content, only metadata.

- [ ] **No LICENSE file** — the project claims to be open source but has no LICENSE file in the repo.

- [ ] **No CONTRIBUTING.md** — no contribution guidelines for the open source community.
