import { defineConfig, devices } from "@playwright/test";

/**
 * smoke:       functional end-to-end checks against a running stack (API + processor + web)
 * walkthrough: narrated product tour recorded to video (docs/media/)
 * The web server is reused when already running (dev or `npm run start`).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["junit", { outputFile: "../../docs/test-results/web-e2e-junit.xml" }]],
  use: {
    baseURL: process.env.WEB_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: process.env.WEB_URL
    ? undefined
    : {
        command: "npm run start",
        url: "http://localhost:3000",
        reuseExistingServer: true,
        timeout: 120_000,
        env: { API_URL: process.env.API_URL ?? "http://localhost:4000", API_KEY: process.env.API_KEY ?? "dev-admin-key-change-me" },
      },
  projects: [
    { name: "smoke", testMatch: /smoke\.spec\.ts/, use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "screenshots", testMatch: /screenshots\.spec\.ts/, use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    {
      name: "walkthrough",
      testMatch: /walkthrough\.spec\.ts/,
      timeout: 600_000,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        video: { mode: "on", size: { width: 1440, height: 900 } },
        launchOptions: { slowMo: 120 },
      },
    },
  ],
});
