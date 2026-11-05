import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 5000 },
  use: {
    baseURL: "http://127.0.0.1:5193",
    viewport: { width: 390, height: 844 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  reporter: [["list"], ["html", { open: "never" }]],
  webServer: {
    command: "npm run dev -- --port 5193 --strictPort",
    url: "http://127.0.0.1:5193",
    reuseExistingServer: false,
  },
});
