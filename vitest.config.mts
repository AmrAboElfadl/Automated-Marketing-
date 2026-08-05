import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node, not jsdom: everything under test is server-side.
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
  },
});
