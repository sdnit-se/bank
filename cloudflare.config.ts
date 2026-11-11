import { bindings, defineConfig, exports } from "cf/config"

// Shebang's copy, at labs.shebang.se/bank. One Workspace Durable Object per Slack team.
// shebang.se's DNS is in Route 53, not Cloudflare, so the Worker has no route of its own: it is served on workers.dev
// and CloudFront forwards labs.shebang.se/bank to it.
// The Cloudflare account comes from CLOUDFLARE_ACCOUNT_ID.
// Secrets live only on the Worker: SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_SIGNING_SECRET, SESSION_SECRET.
export default defineConfig(() => ({
  worker: {
    name: "bank",
    compatibilityDate: "2026-09-08",
    entrypoint: "./src/server/worker.ts",
    assets: { runWorkerFirst: true },
    env: {
      ASSETS: bindings.assets(),
      WORKSPACES: bindings.durableObject({ worker: "bank", exportName: "Workspace" }),
      PUBLIC_URL: bindings.text("https://labs.shebang.se/bank"),
      SLACK_CLIENT_ID: bindings.secret(),
      SLACK_CLIENT_SECRET: bindings.secret(),
      SLACK_SIGNING_SECRET: bindings.secret(),
      SESSION_SECRET: bindings.secret(),
    },
    exports: {
      Workspace: exports.durableObject({ storage: "sqlite" }),
    },
    observability: { enabled: true },
    workersDev: true,
    previewUrls: false,
  },
}))
