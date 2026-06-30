import next from "eslint-config-next"

// Flat config for ESLint 10 + Next.js 16.
// `eslint-config-next` exports a flat-config array (core-web-vitals + TS rules).
const config = [
  ...next,
  {
    ignores: [
      "**/.next/**",
      "**/node_modules/**",
      "next-env.d.ts",
      "drizzle/**",
      // Claude Code worktrees carry their own built .next/node_modules; never
      // lint those (they're third-party/generated, not this project's source).
      ".claude/**",
      ".deepsec/**",
    ],
  },
]

export default config
