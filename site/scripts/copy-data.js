import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "../../data");
const publicDir = join(__dirname, "../public");

const copies = [
  { src: "skills.json", dest: "api/skills.json" },
  { src: "dependencies.json", dest: "api/deps.json" },
  { src: "stats.json", dest: "api/stats.json" },
  { src: "llms.txt", dest: "llms.txt" },
  { src: "llms-full.txt", dest: "llms-full.txt" },
  { src: "search-index.json", dest: "api/search-index.json" },
];

for (const { src, dest } of copies) {
  const srcPath = join(dataDir, src);
  const destPath = join(publicDir, dest);

  if (existsSync(srcPath)) {
    mkdirSync(dirname(destPath), { recursive: true });
    copyFileSync(srcPath, destPath);
    console.log(`Copied ${src} → public/${dest}`);
  } else {
    console.warn(`Warning: ${srcPath} not found, skipping`);
  }
}
