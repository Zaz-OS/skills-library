import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScrapedSkill } from "../../types/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "../../data/raw");
const OUTPUT_FILE = join(DATA_DIR, "skills-sh.json");

const API_BASE = "https://skills.sh/api/skills/all-time";
const PAGE_SIZE = 200;

async function fetchPage(page: number, retries = 3): Promise<{
  skills: ScrapedSkill[];
  hasMore: boolean;
  total: number;
} | null> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${API_BASE}/${page}`, {
        headers: { "User-Agent": "skills-library/0.1 (catalog builder)" },
      });

      if (res.ok) {
        const data = (await res.json()) as {
          skills: { source: string; skillId: string; name: string; installs: number }[];
          hasMore: boolean;
          total: number;
        };

        return {
          skills: data.skills.map((s) => ({
            source: s.source,
            skillId: s.skillId,
            name: s.name,
            installs: s.installs,
          })),
          hasMore: data.hasMore,
          total: data.total,
        };
      }

      if (res.status >= 500 && attempt < retries) {
        console.log(`  Page ${page} returned ${res.status}, retrying (${attempt}/${retries})...`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        continue;
      }

      console.warn(`  Page ${page} failed with ${res.status} after ${attempt} attempts, stopping pagination`);
      return null;
    } catch (err) {
      if (attempt < retries) {
        console.log(`  Page ${page} fetch error, retrying (${attempt}/${retries})...`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        continue;
      }
      console.warn(`  Page ${page} fetch failed after ${retries} attempts: ${err}`);
      return null;
    }
  }
  return null;
}

export async function scrapeSkillsSh(): Promise<ScrapedSkill[]> {
  console.log("Fetching skills from skills.sh API...");

  const allSkills: ScrapedSkill[] = [];
  let page = 0;
  let hasMore = true;
  let total = 0;

  while (hasMore) {
    const result = await fetchPage(page);
    if (!result) {
      console.log(`  Stopping at page ${page} — continuing with ${allSkills.length} skills collected so far`);
      break;
    }
    allSkills.push(...result.skills);
    hasMore = result.hasMore;
    total = result.total;

    console.log(`  Page ${page}: ${result.skills.length} skills (${allSkills.length}/${total})`);
    page++;

    // Small delay to be polite
    if (hasMore) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  // Deduplicate by source/skillId
  const seen = new Set<string>();
  const unique = allSkills.filter((s) => {
    const key = `${s.source}/${s.skillId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`Found ${unique.length} unique skills (${total} total reported by API)`);
  return unique;
}

// Direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  mkdirSync(DATA_DIR, { recursive: true });
  const skills = await scrapeSkillsSh();
  writeFileSync(OUTPUT_FILE, JSON.stringify(skills, null, 2));
  console.log(`Wrote ${skills.length} skills to ${OUTPUT_FILE}`);
}

export default scrapeSkillsSh;
