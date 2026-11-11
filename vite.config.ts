import { cloudflare } from "@cloudflare/vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

// The Cloudflare plugin shapes the build into Build Output for `cf deploy`; dev stays plain Vite.
export default defineConfig(({ command }) => ({
  base: "/bank/",
  plugins: [tailwindcss(), solid(), ...(command === "build" ? [cloudflare()] : [])],
  server: {
    proxy: {
      "^/bank/(api|auth|install|login|logout|slack)": "http://localhost:8787",
    },
  },
}))
