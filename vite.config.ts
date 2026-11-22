import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  server: {
    allowedHosts: ["local.wesbos.com"],
  },
  plugins: [
    react(),
    cloudflare(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Yard Sale Gold",
        short_name: "Gold",
        description: "Spot valuable finds with GPT-5.6 Luna.",
        theme_color: "#11110f",
        background_color: "#f4f0e6",
        display: "standalone",
        start_url: "/scan",
        icons: [
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        // /api navigations (Access sign-in via /api/auth/refresh) must reach the network.
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ["**/*.{js,css,html,svg,woff2}"],
      },
    }),
  ],
});
