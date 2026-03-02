import matter from "gray-matter";
import type { ParsedSkillMd } from "../../../types/index.js";

export function parseSkillMd(content: string): ParsedSkillMd {
  const { data, content: body } = matter(content);

  return {
    name: asString(data.name) ?? "",
    description: asString(data.description) ?? "",
    compatibility: asString(data.compatibility),
    license: asString(data.license),
    allowedTools: asStringArray(data.allowed_tools ?? data.allowedTools),
    metadata: extractMetadata(data),
    body: body.trim(),
  };
}

function asString(val: unknown): string | null {
  if (typeof val === "string" && val.length > 0) return val;
  return null;
}

function asStringArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.filter((v) => typeof v === "string");
  if (typeof val === "string") return [val];
  return [];
}

const KNOWN_FRONTMATTER_KEYS = new Set([
  "name",
  "description",
  "compatibility",
  "license",
  "allowed_tools",
  "allowedTools",
]);

function extractMetadata(data: Record<string, unknown>): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const [key, val] of Object.entries(data)) {
    if (!KNOWN_FRONTMATTER_KEYS.has(key) && typeof val === "string") {
      meta[key] = val;
    }
  }
  return meta;
}
