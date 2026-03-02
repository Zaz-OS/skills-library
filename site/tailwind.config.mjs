/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}"],
  theme: {
    extend: {
      colors: {
        sand: {
          50: "#f8fafc", // slate-50
          100: "#f1f5f9", // slate-100
          200: "#e2e8f0", // slate-200
          300: "#cbd5e1", // slate-300
          400: "#94a3b8", // slate-400
          500: "#64748b", // slate-500
          600: "#475569", // slate-600
          700: "#334155", // slate-700
          800: "#1e293b", // slate-800
          900: "#0f172a", // slate-900
          950: "#020617", // slate-950
        },
        ink: {
          DEFAULT: "#0f172a", // slate-900
          light: "#1e293b", // slate-800
          muted: "#475569", // slate-600
        },
        accent: {
          coral: "#2563eb", // blue-600
          sky: "#0284c7",   // light blue
          sage: "#059669",  // emerald-600
          plum: "#7c3aed",  // violet-600
          gold: "#d97706",  // amber-600
          rose: "#e11d48",  // rose-600
        },
      },
      fontFamily: {
        display: ['"JetBrains Mono"', 'monospace'],
        body: ['"Inter"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
    },
  },
  plugins: [],
};
