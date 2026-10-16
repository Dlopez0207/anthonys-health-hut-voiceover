import { devices, PlaywrightTestConfig } from "@playwright/test";
import { screenReaderConfig } from "@guidepup/playwright";

// screenReaderConfig = { workers: 1, fullyParallel: false, use: { headless: false } }
// Screen readers do not work against headless browsers.
const config: PlaywrightTestConfig = {
  ...screenReaderConfig,
  testDir: "./tests",
  outputDir: "test-results",
  reportSlowTests: null,
  // One test per page template; each runs several hundred VoiceOver commands (>1 s each is possible).
  // v1.2.1 retest: full read-through (no read_scale reduction) + the /contact-us form-submission scenario -> 75 min
  // (the job timeout in .github/workflows/voiceover.yml is 90 min).
  timeout: 75 * 60 * 1000,
  retries: 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  projects: [
    {
      // Playwright's WebKit build (macOS app "Playwright"); the pairing Guidepup recommends for VoiceOver.
      name: "webkit",
      use: { ...devices["Desktop Safari"], headless: false, video: "on" },
    },
    {
      // "Google Chrome For Testing" (applicationNameMap.chromium); green in Guidepup's own CI on macos-15/26.
      name: "chromium",
      use: { ...devices["Desktop Chrome"], headless: false, video: "on" },
    },
  ],
};

export default config;
