import { defineConfig } from "vitest/config"
import tsconfigPaths from "vite-tsconfig-paths"

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    // `**/node_modules/**` (not just top-level) so nested node_modules (e.g.
    // inside .claude/worktrees/*) don't get scanned for third-party *.test.ts.
    exclude: ["**/node_modules/**", ".next/**", ".deepsec/**", ".claude/**"],
  },
})
