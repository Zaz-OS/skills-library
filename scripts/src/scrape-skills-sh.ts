import { parse } from "node-html-parser";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScrapedSkill } from "../../types/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "../../data/raw");
const OUTPUT_FILE = join(DATA_DIR, "skills-sh.json");

async function fetchSkillsPage(): Promise<string> {
  const res = await fetch("https://skills.sh", {
    headers: {
      "User-Agent": "skills-library/0.1 (catalog builder)",
    },
  });
  if (!res.ok) throw new Error(`Failed to fetch skills.sh: ${res.status}`);
  return res.text();
}

function extractSkillsFromHtml(html: string): ScrapedSkill[] {
  // Strategy 1: Look for initialSkills in RSC payload (escaped JSON)
  // RSC format uses escaped quotes: \"initialSkills\":[{\"source\":...}]
  const escapedMatch = html.match(/\\"initialSkills\\":\s*(\[[\s\S]*?\])\s*[,}\\]/);
  if (escapedMatch?.[1]) {
    try {
      // Unescape the JSON string (it's inside an RSC string literal)
      const unescaped = escapedMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      const arr = JSON.parse(unescaped);
      const skills = normalizeSkillArray(arr);
      if (skills.length > 0) return skills;
    } catch {
      // continue
    }
  }

  // Strategy 2: Look for initialSkills in unescaped JSON
  const initialSkillsMatch = html.match(/"initialSkills"\s*:\s*(\[[\s\S]*?\])\s*[,}]/);
  if (initialSkillsMatch?.[1]) {
    try {
      const arr = JSON.parse(initialSkillsMatch[1]);
      const skills = normalizeSkillArray(arr);
      if (skills.length > 0) return skills;
    } catch {
      // continue
    }
  }

  // Strategy 3: Broader search for JSON arrays with skill-like objects
  const jsonArrayMatches = html.matchAll(/\[(\{"source":"[^"]+","skillId":"[^"]+".+?\}(?:,\{"source":"[^"]+","skillId":"[^"]+".+?\})*)\]/g);
  for (const m of jsonArrayMatches) {
    try {
      const arr = JSON.parse(`[${m[1]}]`);
      const skills = normalizeSkillArray(arr);
      if (skills.length > 0) return skills;
    } catch {
      // continue
    }
  }

  // Strategy 3: Parse the DOM for Next.js data structures
  const root = parse(html);
  const scripts = root.querySelectorAll("script");

  for (const script of scripts) {
    const text = script.textContent;

    // __NEXT_DATA__ payload
    if (text.includes("__NEXT_DATA__")) {
      const jsonMatch = text.match(/__NEXT_DATA__\s*=\s*({.+?})\s*;?\s*$/s);
      if (jsonMatch?.[1]) {
        try {
          const data = JSON.parse(jsonMatch[1]);
          return extractFromNextData(data);
        } catch {
          // continue
        }
      }
    }
  }

  const skills: ScrapedSkill[] = [];
  const seen = new Set<string>();

  // Strategy 5: Extract individual skill records (escaped)
  // Handle RSC-escaped format: {\"source\":\"...\",\"skillId\":\"...\"}
  const escapedRecordRe = /\{\\"source\\":\\"([^\\]+)\\",\\"skillId\\":\\"([^\\]+)\\",\\"name\\":\\"([^\\]+)\\",\\"installs\\":(\d+)\}/g;
  let eMatch: RegExpExecArray | null;
  while ((eMatch = escapedRecordRe.exec(html)) !== null) {
    const key = `${eMatch[1]}/${eMatch[2]}`;
    if (!seen.has(key)) {
      seen.add(key);
      skills.push({
        source: eMatch[1],
        skillId: eMatch[2],
        name: eMatch[3],
        installs: parseInt(eMatch[4], 10),
      });
    }
  }
  if (skills.length > 0) return skills;

  // Strategy 6: Extract unescaped individual skill records
  const skillRecordRe = /\{"source":"([^"]+)","skillId":"([^"]+)","name":"([^"]+)","installs":(\d+)\}/g;
  let match: RegExpExecArray | null;

  while ((match = skillRecordRe.exec(html)) !== null) {
    const key = `${match[1]}/${match[2]}`;
    if (!seen.has(key)) {
      seen.add(key);
      skills.push({
        source: match[1],
        skillId: match[2],
        name: match[3],
        installs: parseInt(match[4], 10),
      });
    }
  }

  return skills;
}

function extractFromNextData(data: Record<string, unknown>): ScrapedSkill[] {
  const props = (data as any)?.props?.pageProps;
  if (props?.initialSkills) return normalizeSkillArray(props.initialSkills);
  if (props?.skills) return normalizeSkillArray(props.skills);

  // Deep search
  return findSkillsArray(data);
}

function findSkillsArray(obj: unknown): ScrapedSkill[] {
  if (Array.isArray(obj) && obj.length > 0 && obj[0]?.source && obj[0]?.skillId) {
    return normalizeSkillArray(obj);
  }
  if (obj && typeof obj === "object") {
    for (const val of Object.values(obj as Record<string, unknown>)) {
      const result = findSkillsArray(val);
      if (result.length > 0) return result;
    }
  }
  return [];
}

function normalizeSkillArray(arr: unknown[]): ScrapedSkill[] {
  return arr
    .filter((item): item is Record<string, unknown> => item != null && typeof item === "object")
    .map((item) => ({
      source: String(item.source ?? item.repo ?? ""),
      skillId: String(item.skillId ?? item.skill_id ?? item.id ?? ""),
      name: String(item.name ?? item.title ?? item.skillId ?? ""),
      installs: Number(item.installs ?? item.install_count ?? 0),
    }))
    .filter((s) => s.source && s.skillId);
}

export async function scrapeSkillsSh(): Promise<ScrapedSkill[]> {
  console.log("Fetching skills.sh...");
  const html = await fetchSkillsPage();
  console.log(`Fetched ${html.length} bytes`);

  let skills = extractSkillsFromHtml(html);
  console.log(`Extracted ${skills.length} skills from HTML`);

  // Fallback: use npx skills find
  if (skills.length === 0) {
    console.log("HTML extraction failed, falling back to npx skills find...");
    skills = await fallbackNpxFind();
  }

  return skills;
}

async function fallbackNpxFind(): Promise<ScrapedSkill[]> {
  const { execSync } = await import("node:child_process");
  const categories = [
    "react", "next", "typescript", "python", "docker", "git",
    "testing", "deployment", "database", "api", "security",
    "performance", "accessibility", "design", "devops", "ai",
    "css", "tailwind", "vue", "angular", "svelte", "astro",
    "rust", "go", "java", "ruby", "swift", "kotlin",
    "aws", "gcp", "azure", "vercel", "supabase", "firebase",
    "graphql", "rest", "websocket", "auth", "payment", "email",
    "markdown", "documentation", "linting", "formatting",
    "monorepo", "ci", "cd", "monitoring", "logging",
  ];

  const skills: ScrapedSkill[] = [];
  const seen = new Set<string>();

  // Pattern: owner/repo@skillId followed by install count
  // e.g. "vercel-labs/agent-skills@vercel-react-best-practices 176.8K installs"
  const skillLineRe = /([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)@([a-zA-Z0-9_.:@-]+)/;
  const installsRe = /([\d.]+)([KMB]?)\s*installs/i;

  for (const cat of categories) {
    try {
      const output = execSync(`npx -y skills find "${cat}"`, {
        encoding: "utf-8",
        timeout: 30_000,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      });

      // Strip ANSI codes
      const clean = output.replace(/\x1b\[[0-9;]*m/g, "");

      for (const line of clean.split("\n")) {
        const skillMatch = line.match(skillLineRe);
        if (!skillMatch) continue;

        const source = skillMatch[1];
        const skillId = skillMatch[2];
        const key = `${source}/${skillId}`;
        if (seen.has(key)) continue;
        seen.add(key);

        // Parse installs from next occurrence in the same line or nearby
        let installs = 0;
        const installMatch = line.match(installsRe);
        if (installMatch) {
          const num = parseFloat(installMatch[1]);
          const suffix = (installMatch[2] || "").toUpperCase();
          if (suffix === "K") installs = Math.round(num * 1000);
          else if (suffix === "M") installs = Math.round(num * 1_000_000);
          else if (suffix === "B") installs = Math.round(num * 1_000_000_000);
          else installs = Math.round(num);
        }

        skills.push({
          source,
          skillId,
          name: skillId,
          installs,
        });
      }
    } catch {
      // Ignore errors for individual categories
    }
  }

  return skills;
}

// Direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  mkdirSync(DATA_DIR, { recursive: true });
  const skills = await scrapeSkillsSh();
  writeFileSync(OUTPUT_FILE, JSON.stringify(skills, null, 2));
  console.log(`Wrote ${skills.length} skills to ${OUTPUT_FILE}`);
}

export default scrapeSkillsSh;
