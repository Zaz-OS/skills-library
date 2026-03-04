import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scrapeSkillsSh } from "./scrape-skills-sh.js";
import { syncToD1 } from "./sync-d1.js";

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

  // Step 2: Sync to D1
  console.log("--- Step 2: Syncing to D1 ---");
  await syncToD1(scrapedSkills);
  console.log("");

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`=== Pipeline complete in ${elapsed}s ===`);
}

run().catch((err) => {
  console.error("Pipeline failed:", err);
  process.exit(1);
});
