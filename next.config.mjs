import { withWorkflow } from "workflow/next"

const e2eDistDir = process.env.FLEET_MCP_E2E_DIST_DIR

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(e2eDistDir ? { distDir: e2eDistDir } : {}),
  images: {
    unoptimized: true,
  },
  experimental: {
    // Keep prefetched/visited routes warm in the client router cache so
    // tab-switching is instant. Mutations call revalidatePath(), which refreshes
    // the affected path, so 30s of staleness only ever applies to untouched data.
    // ponytail: 30s is a safe dashboard default; raise dynamic if nav must feel instant longer.
    staleTimes: { dynamic: 30, static: 300 },
  },
}

// withWorkflow enables the "use workflow" / "use step" directive transform.
// Without it, start(updateFleet) throws "invalid workflow function".
export default withWorkflow(nextConfig)
