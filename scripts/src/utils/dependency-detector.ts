import type { Dependency } from "../../../types/index.js";

interface DetectionPattern {
  pattern: RegExp;
  type: Dependency["type"];
  org: string;
  name: string;
}

const PATTERNS: DetectionPattern[] = [
  // npm / Node
  { pattern: /\bnpm\s+install\b/i, type: "npm", org: "npm", name: "npm" },
  { pattern: /\bnpx\s+/i, type: "npm", org: "npm", name: "npx" },
  { pattern: /\bpnpm\s+(add|install)\b/i, type: "npm", org: "pnpm", name: "pnpm" },
  { pattern: /\byarn\s+add\b/i, type: "npm", org: "yarn", name: "yarn" },
  { pattern: /\bbun\s+(add|install)\b/i, type: "npm", org: "bun", name: "bun" },

  // Python
  { pattern: /\bpip\s+install\b/i, type: "pip", org: "pip", name: "pip" },
  { pattern: /\bpip3\s+install\b/i, type: "pip", org: "pip", name: "pip3" },
  { pattern: /\bpython3?\b/i, type: "pip", org: "python", name: "python" },
  { pattern: /\bpipx?\s+install\b/i, type: "pip", org: "pip", name: "pipx" },
  { pattern: /\buv\s+(pip|run|sync)\b/i, type: "pip", org: "astral", name: "uv" },

  // Brew
  { pattern: /\bbrew\s+install\b/i, type: "brew", org: "homebrew", name: "brew" },

  // System / apt
  { pattern: /\bapt-get\s+install\b/i, type: "system", org: "apt", name: "apt-get" },
  { pattern: /\bapt\s+install\b/i, type: "system", org: "apt", name: "apt" },

  // Docker
  { pattern: /\bdocker\b/i, type: "service", org: "docker", name: "docker" },
  { pattern: /\bdocker[- ]compose\b/i, type: "service", org: "docker", name: "docker-compose" },

  // Cloud services
  { pattern: /\bgcloud\b/i, type: "service", org: "google", name: "gcloud" },
  { pattern: /\baws\s+/i, type: "service", org: "aws", name: "aws-cli" },
  { pattern: /\baz\s+/i, type: "service", org: "azure", name: "az-cli" },
  { pattern: /\bvercel\b/i, type: "service", org: "vercel", name: "vercel-cli" },
  { pattern: /\bsupabase\b/i, type: "service", org: "supabase", name: "supabase" },
  { pattern: /\bfirebase\b/i, type: "service", org: "google", name: "firebase" },
  { pattern: /\bflyctl\b|\bfly\.io\b/i, type: "service", org: "fly", name: "flyctl" },
  { pattern: /\brailway\b/i, type: "service", org: "railway", name: "railway" },
  { pattern: /\bnetlify\b/i, type: "service", org: "netlify", name: "netlify-cli" },

  // Common CLI tools
  { pattern: /\bjq\b/, type: "system", org: "jq", name: "jq" },
  { pattern: /\bcurl\b/, type: "system", org: "curl", name: "curl" },
  { pattern: /\bwget\b/, type: "system", org: "wget", name: "wget" },
  { pattern: /\bffmpeg\b/i, type: "system", org: "ffmpeg", name: "ffmpeg" },
  { pattern: /\bimagemagick\b|\bconvert\b/i, type: "system", org: "imagemagick", name: "imagemagick" },
  { pattern: /\bgit\s+(clone|pull|push)\b/i, type: "system", org: "git", name: "git" },

  // Databases
  { pattern: /\bpostgres(ql)?\b/i, type: "service", org: "postgresql", name: "postgresql" },
  { pattern: /\bmysql\b/i, type: "service", org: "mysql", name: "mysql" },
  { pattern: /\bredis\b/i, type: "service", org: "redis", name: "redis" },
  { pattern: /\bmongodb\b|\bmongosh\b/i, type: "service", org: "mongodb", name: "mongodb" },

  // Runtimes
  { pattern: /\bdeno\b/i, type: "system", org: "deno", name: "deno" },
  { pattern: /\bruby\b/i, type: "system", org: "ruby", name: "ruby" },
  { pattern: /\bgem\s+install\b/i, type: "system", org: "ruby", name: "gem" },
  { pattern: /\brustup\b|\bcargo\b/i, type: "system", org: "rust", name: "cargo" },
  { pattern: /\bgo\s+(get|install|build)\b/i, type: "system", org: "go", name: "go" },
];

const NPM_PACKAGE_RE = /(?:npm\s+install|npx|pnpm\s+add|yarn\s+add|bun\s+add)\s+(?:-[gDd]\s+)?([a-z@][a-z0-9._\-/@]*)/gi;
const PIP_PACKAGE_RE = /(?:pip3?\s+install|pipx\s+install|uv\s+pip\s+install)\s+(?:--[a-z-]+\s+)*([a-z][a-z0-9._-]*)/gi;
const BREW_PACKAGE_RE = /brew\s+install\s+(?:--[a-z-]+\s+)*([a-z][a-z0-9._\-/@]*)/gi;

function extractPackages(text: string, regex: RegExp, type: Dependency["type"], detectedFrom: Dependency["detectedFrom"]): Dependency[] {
  const deps: Dependency[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;

  // Reset regex
  regex.lastIndex = 0;

  while ((match = regex.exec(text)) !== null) {
    const pkg = match[1];
    if (pkg && !seen.has(pkg)) {
      seen.add(pkg);
      const org = pkg.startsWith("@") ? pkg.split("/")[0].slice(1) : pkg.split("/")[0];
      deps.push({
        type,
        org,
        name: pkg,
        detectedFrom,
      });
    }
  }

  return deps;
}

export function detectDependencies(
  text: string,
  detectedFrom: Dependency["detectedFrom"]
): Dependency[] {
  const deps: Dependency[] = [];
  const seen = new Set<string>();

  // Check broad patterns first
  for (const { pattern, type, org, name } of PATTERNS) {
    if (pattern.test(text)) {
      const key = `${type}:${name}`;
      if (!seen.has(key)) {
        seen.add(key);
        deps.push({ type, org, name, detectedFrom });
      }
    }
  }

  // Extract specific package names
  const npmPkgs = extractPackages(text, NPM_PACKAGE_RE, "npm", detectedFrom);
  const pipPkgs = extractPackages(text, PIP_PACKAGE_RE, "pip", detectedFrom);
  const brewPkgs = extractPackages(text, BREW_PACKAGE_RE, "brew", detectedFrom);

  for (const dep of [...npmPkgs, ...pipPkgs, ...brewPkgs]) {
    const key = `${dep.type}:${dep.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      deps.push(dep);
    }
  }

  return deps;
}

export function detectFromCompatibility(compatField: string): Dependency[] {
  return detectDependencies(compatField, "compatibility");
}

export function detectFromInstructions(body: string): Dependency[] {
  return detectDependencies(body, "instructions");
}

export function detectFromScripts(scriptContent: string): Dependency[] {
  const deps = detectDependencies(scriptContent, "scripts");

  // Also check shebang lines
  const shebangMatch = scriptContent.match(/^#!\s*\/usr\/bin\/env\s+(\w+)/m);
  if (shebangMatch) {
    const runtime = shebangMatch[1];
    if (runtime && !["bash", "sh", "zsh"].includes(runtime)) {
      deps.push({
        type: runtime === "python" || runtime === "python3" ? "pip" : "system",
        org: runtime,
        name: runtime,
        detectedFrom: "scripts",
      });
    }
  }

  return deps;
}

export function deduplicateDeps(deps: Dependency[]): Dependency[] {
  const seen = new Map<string, Dependency>();
  for (const dep of deps) {
    const key = `${dep.type}:${dep.name}`;
    if (!seen.has(key)) {
      seen.set(key, dep);
    }
  }
  return Array.from(seen.values());
}
