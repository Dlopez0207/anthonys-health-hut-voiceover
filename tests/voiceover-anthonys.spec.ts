// Real macOS VoiceOver session, driven with Guidepup, against the published anthonyshealthhutlakeland.com
// (baseline, before any remediation). One test per page template. Each test writes
// transcripts/<slug>/voiceover-transcript-<browser>.txt (header + "### " sections + numbered phrases).
import { voiceOverTest as test } from "@guidepup/playwright";
import { expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { release } from "node:os";

const ORIGIN = "https://www.anthonyshealthhutlakeland.com";
const PAGES = [
  { slug: "home", path: "/", read: 220 },
  { slug: "about-us", path: "/about-us", read: 170 },
  { slug: "contact-us", path: "/contact-us", read: 150 },
  { slug: "menu", path: "/menu", read: 150 },
  { slug: "vitamins-and-minerals", path: "/vitamins-and-minerals", read: 170 },
];
const wanted = (process.env.VO_PAGES ?? "all").split(",").map((s) => s.trim()).filter(Boolean);
const selected = wanted.includes("all") ? PAGES : PAGES.filter((p) => wanted.includes(p.slug));
const HEADING_STEPS = Number(process.env.VO_HEADING_STEPS ?? 30);
const LANDMARK_STEPS = Number(process.env.VO_LANDMARK_STEPS ?? 12);
const TAB_STEPS = Number(process.env.VO_TAB_STEPS ?? 60);
const READ_SCALE = Number(process.env.VO_READ_SCALE ?? 1);

type Section = { title: string; phrases: string[]; end: string };
const num = (i: number) => String(i).padStart(3, " ");

test.describe("VoiceOver — anthonyshealthhutlakeland.com (baseline)", () => {
  for (const pg of selected) {
    test(`${pg.slug}: read-through, headings, landmarks and Tab order`, async ({ page, voiceOver, browserName }, testInfo) => {
      const url = `${ORIGIN}${pg.path}`;
      await page.goto(url, { waitUntil: "load" });
      await page.locator("body").waitFor();
      await page.waitForTimeout(3000);
      // The site shows no cookie banner or marketing popup; record what third-party overlays are present.
      const overlays = await page.evaluate(() => {
        const found: string[] = [];
        if (document.querySelector(".grecaptcha-badge")) found.push("Google reCAPTCHA badge (bottom right)");
        const pop = document.querySelector("#dmPopup") as HTMLElement | null;
        if (pop && pop.offsetParent !== null && getComputedStyle(pop).display !== "none") found.push("Duda popup visible");
        return found.join("; ") || "none";
      });

      await voiceOver.navigateToWebContent();
      await voiceOver.clearSpokenPhraseLog();
      await voiceOver.clearItemTextLog();

      const sections: Section[] = [];
      // VoiceOver occasionally dies on the hosted runner ("VoiceOver not running"): restart it and go back to the web content.
      const back = async () => { try { await voiceOver.navigateToWebContent(); } catch (e) { sections.push({ title: "(VoiceOver restarted)", phrases: [], end: String(e).slice(0, 100) }); try { await voiceOver.stop(); } catch {} await voiceOver.start(); await page.bringToFront().catch(() => {}); await voiceOver.navigateToWebContent(); } };
      const say = async () => (await voiceOver.lastSpokenPhrase()).replace(/\s+/g, " ").trim();

      // Stop when the same phrase repeats three times in a row (end of content) or when the first phrase comes back (wrap-around).
      const run = async (title: string, max: number, step: () => Promise<void>, wrap: boolean) => {
        const phrases: string[] = []; let end = `limit of ${max} steps`; let repeat = 0;
        for (let i = 1; i <= max; i++) {
          try { await step(); } catch (e) { end = `error: ${String(e).slice(0, 120)}`; break; }
          const p = await say();
          if (phrases.length && p === phrases[phrases.length - 1]) { if (++repeat >= 2) { end = "end of content (repeated phrase)"; break; } } else repeat = 0;
          if (wrap && phrases.length > 1 && p === phrases[0]) { end = "wrapped to the first item"; break; }
          phrases.push(p);
        }
        sections.push({ title, phrases, end });
        return phrases;
      };

      await run("Read-through from the top (VO-Right Arrow)", Math.round(pg.read * READ_SCALE), () => voiceOver.next({ capture: true }), false);

      await back();
      await run("Heading navigation (VO-Cmd-H)", HEADING_STEPS, () => voiceOver.nextHeading({ capture: true }), true);

      await back();
      const vo: any = voiceOver;
      const landmarkCmd = vo.keyboardCommands?.findNextLandmark ?? vo.keyboardCommands?.findNextLandmarkOrItem;
      if (typeof vo.nextLandmark === "function") await run("Landmark navigation (VO-Cmd-L)", LANDMARK_STEPS, () => vo.nextLandmark({ capture: true }), true);
      else if (landmarkCmd) await run("Landmark navigation (VO-Cmd-L)", LANDMARK_STEPS, () => voiceOver.perform(landmarkCmd, { capture: true }), true);
      else sections.push({ title: "Landmark navigation (VO-Cmd-L)", phrases: [], end: "command not available in this Guidepup version" });

      await back();
      await run("Tab order (Tab key)", TAB_STEPS, () => voiceOver.press("Tab"), false);

      const spoken: string[] = await voiceOver.spokenPhraseLog().catch(() => [] as string[]);
      const total = sections.reduce((a, s) => a + s.phrases.length, 0);
      const lines: string[] = [
        `Screen reader: VoiceOver ${voiceOver.version ?? ""} (macOS ${release()}, real session driven with Guidepup)`.replace(/\s+\(/, " ("),
        `Page: ${url}`,
        `Rendered page: ${page.url()}`,
        `Browser: ${browserName} (Playwright project "${testInfo.project.name}")`,
        `Runner: GitHub Actions ${process.env.RUNNER_OS_LABEL ?? "local"}`,
        `Session date (UTC): ${new Date().toISOString()}`,
        `Mode: real session, published site, no remediation applied`,
        `Third-party overlays present: ${overlays}`,
        `Phrases captured: ${total}`,
        ``,
        `Each line is one phrase exactly as VoiceOver spoke it.`,
        `────────────────────────────────────────────────────────`,
        ``,
      ];
      for (const s of sections) {
        lines.push(`### ${s.title} (${s.phrases.length} phrases, end: ${s.end})`);
        s.phrases.forEach((p, i) => lines.push(`${num(i + 1)}  ${p}`));
        lines.push("");
      }
      lines.push(`### Full VoiceOver log (spokenPhraseLog, ${spoken.length} entries)`);
      spoken.forEach((p, i) => lines.push(`${num(i + 1)}  ${p.replace(/\s+/g, " ").trim()}`));

      const outDir = join(process.cwd(), "transcripts", pg.slug);
      mkdirSync(outDir, { recursive: true });
      const file = join(outDir, `voiceover-transcript-${browserName}.txt`);
      writeFileSync(file, lines.join("\n") + "\n", "utf8");
      await testInfo.attach(`voiceover-${pg.slug}-${browserName}`, { path: file, contentType: "text/plain" });
      expect(total).toBeGreaterThan(10);
    });
  }
});
