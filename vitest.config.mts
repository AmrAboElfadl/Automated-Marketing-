import { defineConfig } from "vitest/config";

export default defineConfig({
  // tsconfig sets jsx: "preserve" because Next.js compiles JSX itself. Vite
  // cannot transform that, so the test run compiles JSX with the automatic
  // runtime instead. This affects tests only, never the production build.
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  test: {
    // Node, not jsdom: everything under test is server-side.
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["node_modules/**", ".next/**"],
    alias: {
      // Mirrors the "@/*" path mapping in tsconfig.json.
      "@/": new URL("./", import.meta.url).pathname,
    },
  },
});
