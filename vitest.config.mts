import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["extensions/**/*.test.ts"],
    exclude: ["node_modules", "npm", "extensions/_archive", "extensions/vim-session"],
  },
  resolve: {
    alias: {
      "@earendil-works/pi-coding-agent": resolve(__dirname, "extensions/test/mocks/pi-coding-agent.ts"),
      "@earendil-works/pi-tui": resolve(__dirname, "extensions/test/mocks/pi-tui.ts"),
      typebox: resolve(__dirname, "extensions/test/mocks/typebox.ts"),
    },
  },
});
