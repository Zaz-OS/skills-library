import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scrapeSkillsSh } from "./scrape-skills-sh.js";
import { processRepos } from "./process-repos.js";
import { enrichWithGithub } from "./enrich.js";
import { buildCatalog, writeCatalog } from "./build-catalog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "../../data/raw");

async function run() {
  const startTime = Date.now();
  console.log("=== skills-library pipeline ===\n");

  mkdirSync(DATA_DIR, { recursive: true });

  // Step 1: Scrape skills.sh
  console.log("--- Step 1: Scraping skills.sh ---");
  const scrapedSkills = await scrapeSkillsSh();
  console.log(`Found ${scrapedSkills.length} skills\n`);

  // Step 2: Process repos
  console.log("--- Step 2: Processing source repos ---");
  const repos = await processRepos(scrapedSkills);
  console.log(`Processed ${repos.length} repos\n`);

  // Step 3: Enrich with GitHub data
  console.log("--- Step 3: Enriching with GitHub data ---");
  const githubMeta = await enrichWithGithub(repos);
  console.log(`Enriched ${Object.keys(githubMeta).length} repos\n`);

  // Step 4: Build catalog
  console.log("--- Step 4: Building catalog ---");
  const catalog = buildCatalog(scrapedSkills, repos, githubMeta);
  writeCatalog(catalog);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== Pipeline complete in ${elapsed}s ===`);
}

run().catch((err) => {
  console.error("Pipeline failed:", err);
  process.exit(1);
});
