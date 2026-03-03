import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";
import { readFileSync } from "node:fs";

// Load .env manually (runs before Vite env loading)
try {
  const envFile = readFileSync(".env", "utf-8");
  for (const line of envFile.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (key && !process.env[key]) process.env[key] = rest.join("=");
  }
} catch {}

export default defineConfig({
  site: "https://skills-library.com",
  integrations: [tailwind()],
  output: "static",
  i18n: {
    defaultLocale: "en",
    locales: ["en", "pt-br"],
    routing: {
      prefixDefaultLocale: false,
    },
  },
  vite: {
    server: {
      allowedHosts: process.env.VITE_ALLOWED_HOSTS
        ? process.env.VITE_ALLOWED_HOSTS.split(",")
        : [],
    },
  },
});
