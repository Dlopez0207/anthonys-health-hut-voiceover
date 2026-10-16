// Real macOS VoiceOver session, driven with Guidepup, against the published anthonyshealthhutlakeland.com
// (baseline, before any remediation). One test per page template. Each test writes
// transcripts/<slug>/voiceover-transcript-<browser>.txt (header + "### " sections + numbered phrases).
import { voiceOverTest as test } from "@guidepup/playwright";
import { expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { release } from "node:os";

const ORIGIN = process.env.VO_ORIGIN ?? "https://www.anthonyshealthhutlakeland.com";
const RETEST = ORIGIN.startsWith("http://localhost");
// read = the most VO-Right Arrow steps of the read-through. Since the v1.2.1 retest these are upper bounds well above
// each page's length (the read normally ends with "end of content"); a time budget (VO_READ_BUDGET_MIN) keeps the
// remaining sections inside the test timeout and is reported as the end reason when it is what stopped the read.
const PAGES = [
  { slug: "home", path: "/", read: 500 },
  { slug: "about-us", path: "/about-us", read: 400 },
  { slug: "contact-us", path: "/contact-us", read: 400 },
  { slug: "menu", path: "/menu", read: 800 },
  { slug: "vitamins-and-minerals", path: "/vitamins-and-minerals", read: 400 },
];
const wanted = (process.env.VO_PAGES ?? "all").split(",").map((s) => s.trim()).filter(Boolean);
const selected = wanted.includes("all") ? PAGES : PAGES.filter((p) => wanted.includes(p.slug));
const HEADING_STEPS = Number(process.env.VO_HEADING_STEPS ?? 30);
const LANDMARK_STEPS = Number(process.env.VO_LANDMARK_STEPS ?? 12);
const TAB_STEPS = Number(process.env.VO_TAB_STEPS ?? 60);
const READ_SCALE = Number(process.env.VO_READ_SCALE ?? 1);
const READ_BUDGET_MS = Number(process.env.VO_READ_BUDGET_MIN ?? 40) * 60 * 1000;
// Form-submission scenario on /contact-us (retest only; human-review item FM-12): VO_FORM=0 turns it off.
const FORM_SCENARIO = RETEST && (process.env.VO_FORM ?? "1") !== "0";
// Valid fake data for the simulated submissions (nothing is sent: the staging server's form mock answers locally).
const FAKE = { name: "Test", email: "test@example.com", phone: "5555550100", message: "Accessibility test" };
// TEST-ONLY stand-in for Google's reCAPTCHA, installed ONLY in the form-submission scenario (addInitScript, and the
// api.js request answered locally with the same code, so Google is never contacted): render() adds the hidden
// g-recaptcha-response field as Google's widget does and execute() hands Duda's callback a dummy token, so Duda's own
// submit code runs end to end against the staging form mock. Same stub as the local suites (fixed/tests/helpers/forms.ts).
const RECAPTCHA_STUB = `(function () {
  var s = document.currentScript && document.currentScript.src || "";
  var m = s.match(/[?&]onload=([^&]+)/);
  var cb = m ? decodeURIComponent(m[1]) : "onCaptchaLoad";
  if (!(window.grecaptcha && window.grecaptcha.adaTestStub)) {
    var cbs = {}, n = 0;
    window.grecaptcha = {
      adaTestStub: true,
      ready: function (f) { setTimeout(f, 0); },
      render: function (el, o) {
        var id = n++; cbs[id] = o && o.callback;
        var t = document.createElement("textarea"); t.name = "g-recaptcha-response"; t.className = "g-recaptcha-response"; t.style.display = "none";
        if (el && el.appendChild) { el.appendChild(t); cbs["t" + id] = t; }
        return id;
      },
      execute: function (id) { var k = id == null ? 0 : id, f = cbs[k] || cbs[0], t = cbs["t" + k] || cbs.t0; setTimeout(function () { if (t) t.value = "ada-simulated-token"; if (f) f("ada-simulated-token"); }, 50); },
      reset: function () {},
      getResponse: function () { return "ada-simulated-token"; }
    };
  }
  setTimeout(function () { if (typeof window[cb] === "function") window[cb](); }, 0);
})();`;

type Section = { title: string; phrases: string[]; end: string; notes?: string[] };
const num = (i: number) => String(i).padStart(3, " ");

test.describe(RETEST ? "VoiceOver — anthonyshealthhutlakeland.com (retest, corrected copy)" : "VoiceOver — anthonyshealthhutlakeland.com (baseline)", () => {
  for (const pg of selected) {
    test(`${pg.slug}: read-through, headings, landmarks and Tab order`, async ({ page, voiceOver, browserName }, testInfo) => {
      const t0 = Date.now();
      const left = () => testInfo.timeout - (Date.now() - t0);
      const formHere = FORM_SCENARIO && pg.slug === "contact-us";
      // Time kept back for the sections after the read-through (and the form scenario on /contact-us).
      const RESERVE = formHere ? 22 * 60 * 1000 : 14 * 60 * 1000;
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
      // Time guards: stop at `budgetEnd` (read-through) or when less than `reserve` ms of the test timeout is left.
      const run = async (title: string, max: number, step: () => Promise<void>, wrap: boolean, budgetEnd = Infinity, reserve = 4 * 60 * 1000) => {
        const phrases: string[] = []; let end = `limit of ${max} steps`; let repeat = 0;
        for (let i = 1; i <= max; i++) {
          if (Date.now() > budgetEnd) { end = `time budget of ${Math.round(READ_BUDGET_MS / 60000)} min reached after ${phrases.length} phrases`; break; }
          if (left() < reserve) { end = `stopped to keep time for the remaining sections (${Math.round(left() / 60000)} min left)`; break; }
          try { await step(); } catch (e) { end = `error: ${String(e).slice(0, 120)}`; break; }
          const p = await say();
          if (phrases.length && p === phrases[phrases.length - 1]) { if (++repeat >= 2) { end = "end of content (repeated phrase)"; break; } } else repeat = 0;
          if (wrap && phrases.length > 1 && p === phrases[0]) { end = "wrapped to the first item"; break; }
          phrases.push(p);
        }
        sections.push({ title, phrases, end });
        flush();
        return phrases;
      };

      const header = (total: number) => [
        `Screen reader: VoiceOver ${voiceOver.version ?? ""} (macOS ${release()}, real session driven with Guidepup)`.replace(/\s+\(/, " ("),
        `Page: ${url}`,
        `Rendered page: ${page.url()}`,
        `Browser: ${browserName} (Playwright project "${testInfo.project.name}")`,
        `Runner: GitHub Actions ${process.env.RUNNER_OS_LABEL ?? "local"}`,
        `Session date (UTC): ${new Date().toISOString()}`,
        RETEST ? `Mode: real session, corrected staging copy (published pages + Head HTML ${process.env.VO_PACKAGE ?? "v1.2.0"} + simulated Duda editor changes), served on the runner` : `Mode: real session, published site, no remediation applied`,
        ...(RETEST && process.env.VO_HEAD_SHA ? [`Head HTML SHA-256: ${process.env.VO_HEAD_SHA}`] : []),
        ...(RETEST && process.env.VO_STAGING_MODE ? [`Staging copy: ${process.env.VO_STAGING_MODE}`] : []),
        `Read-through: up to ${Math.round(pg.read * READ_SCALE)} steps (read_scale ${READ_SCALE}), time budget ${Math.round(READ_BUDGET_MS / 60000)} min`,
        `Third-party overlays present: ${overlays}`,
        `Phrases captured: ${total}`,
        ``,
        `Each line is one phrase exactly as VoiceOver spoke it.`,
        `────────────────────────────────────────────────────────`,
        ``,
      ];
      const outDir = join(process.cwd(), "transcripts", pg.slug);
      mkdirSync(outDir, { recursive: true });
      const file = join(outDir, `voiceover-transcript-${browserName}.txt`);
      // Written after every section, so a runner that dies or a timeout still leaves the sections already captured.
      function flush(spoken?: string[]) {
        const total = sections.reduce((a, s) => a + s.phrases.length, 0);
        const lines = header(total);
        for (const s of sections) {
          lines.push(`### ${s.title} (${s.phrases.length} phrases, end: ${s.end})`);
          s.phrases.forEach((p, i) => lines.push(`${num(i + 1)}  ${p}`));
          (s.notes ?? []).forEach((n) => lines.push(`     note: ${n}`));
          lines.push("");
        }
        if (spoken) {
          lines.push(`### Full VoiceOver log (spokenPhraseLog, ${spoken.length} entries)`);
          spoken.forEach((p, i) => lines.push(`${num(i + 1)}  ${p.replace(/\s+/g, " ").trim()}`));
        } else lines.push(`### (session still running or interrupted: full VoiceOver log not written yet)`);
        writeFileSync(file, lines.join("\n") + "\n", "utf8");
      }

      await run("Read-through from the top (VO-Right Arrow)", Math.round(pg.read * READ_SCALE), () => voiceOver.next({ capture: true }), false, t0 + READ_BUDGET_MS, RESERVE);

      await back();
      await run("Heading navigation (VO-Cmd-H)", HEADING_STEPS, () => voiceOver.nextHeading({ capture: true }), true);

      await back();
      const vo: any = voiceOver;
      const landmarkCmd = vo.keyboardCommands?.findNextLandmark ?? vo.keyboardCommands?.findNextLandmarkOrItem;
      if (typeof vo.nextLandmark === "function") await run("Landmark navigation (VO-Cmd-L)", LANDMARK_STEPS, () => vo.nextLandmark({ capture: true }), true);
      else if (landmarkCmd) await run("Landmark navigation (VO-Cmd-L)", LANDMARK_STEPS, () => voiceOver.perform(landmarkCmd, { capture: true }), true);
      else sections.push({ title: "Landmark navigation (VO-Cmd-L)", phrases: [], end: "command not available in this Guidepup version" });

      await back();
      await run("Tab order (Tab key)", TAB_STEPS, () => voiceOver.press("Tab"), false, Infinity, formHere ? 9 * 60 * 1000 : 2 * 60 * 1000);

      // ---------------------------------------------------------------- Form submission scenario (/contact-us, FM-12)
      const formScenario = async () => {
        const clean = (p: string) => p.replace(/\s+/g, " ").trim();
        // Every distinct phrase VoiceOver speaks during `action` (Guidepup capture: polls VoiceOver's last phrase until stable).
        const cap = async (action: () => Promise<unknown>): Promise<string> => {
          try {
            if (typeof vo.capture === "function") return clean((await vo.capture(action, { capture: true }))?.spokenPhrase ?? "");
            await action();
            return await say();
          } catch (e) { return `(capture error: ${String(e).slice(0, 80)})`; }
        };
        // Announcements that arrive after the key press (live regions): listen in `rounds` windows of `ms` ms.
        const listen = async (out: string[], ms = 1500, rounds = 6) => {
          for (let i = 0; i < rounds; i++) {
            const p = await cap(() => page.waitForTimeout(ms));
            if (p && !out.includes(p)) out.push(p);
          }
        };
        const FORM = "form.dmRespDesignRow";
        const formState = () => page.evaluate((FORM) => {
          const vis = (el: Element | null) => !!el && (el as HTMLElement).offsetParent !== null && getComputedStyle(el).display !== "none" && getComputedStyle(el).visibility !== "hidden";
          const forms = Array.from(document.querySelectorAll(FORM)); const f = forms.find(vis) || forms[0];
          const w = f ? f.closest(".dmform") || f.parentElement : null;
          const txt = (el: Element) => ((el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
          const ae = document.activeElement as HTMLElement | null;
          const desc = (el: HTMLElement | null) => {
            if (!el) return "none";
            const t = el.getAttribute("type");
            let d = el.tagName.toLowerCase() + (t ? `[type=${t}]` : "") + (el.id ? `#${el.id}` : "") + (el.getAttribute("name") ? `[name=${el.getAttribute("name")}]` : "");
            if (el.tagName === "INPUT" && /submit|button/.test(t || "")) d += ` "${(el as HTMLInputElement).value}"`;
            return d;
          };
          const alerts = Array.from(document.querySelectorAll('[role="alert"], [role="status"], [aria-live]')).filter((el) => vis(el) && txt(el)).map((el) => `${el.getAttribute("role") || "aria-live=" + el.getAttribute("aria-live")}: "${txt(el)}"`);
          const invalid = f ? Array.from(f.querySelectorAll('[aria-invalid="true"]')).map((el) => desc(el as HTMLElement)) : [];
          const box = (el: Element | null | undefined) => el ? { shown: vis(el), role: el.getAttribute("role"), live: el.getAttribute("aria-live"), text: txt(el) } : null;
          return {
            active: desc(ae), inForm: !!(ae && f && f.contains(ae)), alerts, invalid,
            errorBox: box(w?.querySelector(".dmform-error")), successBox: box(w?.querySelector(".dmform-success")),
            stub: !!((window as any).grecaptcha && (window as any).grecaptcha.adaTestStub),
          };
        }, FORM);
        const boxText = (b: { shown: boolean; role: string | null; live: string | null; text: string } | null) => b ? `${b.shown ? "shown" : "hidden"} (role=${b.role}, aria-live=${b.live})${b.shown ? ` "${b.text}"` : ""}` : "absent";
        const formLog = async () => { try { const r = await page.request.get(`${ORIGIN}/__staging/form-log`); return ((await r.json()).entries ?? []) as any[]; } catch { return [] as any[]; } };
        const visibleForm = async () => { const fs = page.locator(FORM); const n = await fs.count(); for (let i = 0; i < n; i++) if (await fs.nth(i).isVisible()) return fs.nth(i); return fs.first(); };
        const submitOf = (f: ReturnType<typeof page.locator>) => f.locator('input[type="submit"], button[type="submit"]').first();
        const SIM = "Simulated send: no message was sent. Duda's form request went to the staging server's local form mock (never forwarded to Duda or anyone else); Google reCAPTCHA was replaced by a test-only stub in this form-submission scenario only.";

        // The stub applies to the three form loads below only (read-through, headings, landmarks and Tab order ran without it).
        await page.addInitScript({ content: RECAPTCHA_STUB });
        await page.route(/\/recaptcha\/(api|enterprise)\.js/, (r) => r.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: RECAPTCHA_STUB }));
        const log0 = (await formLog()).length;

        // (a) Tab to the form, submit it empty, capture the error messages.
        const titleA = "Form submission (a): empty form submitted from the keyboard, field error messages";
        try {
          await page.goto(`${ORIGIN}/contact-us`, { waitUntil: "load" });
          await page.waitForTimeout(3000);
          await back();
          const phrases: string[] = []; const notes: string[] = []; const marks: string[] = [];
          let tabs = 0;
          for (; tabs < 150; tabs++) {
            if (await page.evaluate((FORM) => !!(document.activeElement && document.activeElement.closest && document.activeElement.closest(FORM)), FORM)) break;
            await voiceOver.press("Tab", { capture: false });
          }
          const reached = await formState();
          notes.push(`Tab from the top of the page: keyboard focus reached the form after ${tabs} Tab presses (${reached.active}).`);
          // Shift+Tab, then Tab again, so VoiceOver's announcement of the first field is captured.
          await voiceOver.press("Shift+Tab", { capture: false });
          await page.waitForTimeout(400);
          phrases.push(await cap(() => voiceOver.press("Tab", { capture: false }))); marks.push("Tab into the first field");
          for (let i = 0; i < 6; i++) {
            if (/type=submit|type=button|^button/.test((await formState()).active)) break;
            phrases.push(await cap(() => voiceOver.press("Tab", { capture: false }))); marks.push("Tab");
          }
          const atSubmit = await formState();
          if (!/type=submit|type=button|^button/.test(atSubmit.active)) { notes.push(`Send Message not reached by Tab (focus on ${atSubmit.active}); focused programmatically.`); await submitOf(await visibleForm()).focus(); }
          const before = phrases.length;
          phrases.push(await cap(() => voiceOver.press("Enter", { capture: false })));
          await listen(phrases);
          const st = await formState();
          notes.push(`Phrases 1-${before}: ${marks.join(", ")} (focus ended on ${atSubmit.active}); phrase ${before + 1}: Enter on Send Message with every field empty; phrases ${before + 2}+: further announcements in the 9 s after the submission (distinct phrases only).`);
          notes.push(`DOM after the empty submission: focus on ${st.active}; aria-invalid fields: ${st.invalid.join(", ") || "none"}; visible role=alert/status/aria-live regions: ${st.alerts.join(" | ") || "none"}; send-error box ${boxText(st.errorBox)}; success box ${boxText(st.successBox)}.`);
          notes.push(`No request is sent for an empty form (Duda validates first). reCAPTCHA test stub active: ${st.stub ? "yes" : "no"} (this scenario only).`);
          sections.push({ title: titleA, phrases: phrases.filter(Boolean), end: "scenario complete", notes });
        } catch (e) { sections.push({ title: titleA, phrases: [], end: `error: ${String(e).slice(0, 160)}` }); }
        flush();

        // (b) simulated send failure (?mock=error: the staging form mock answers HTTP 500) and (c) inline success.
        const runs = [
          ["error", "Form submission (b): simulated send failure (?mock=error, staging form mock answers HTTP 500), send-error message"],
          ["success-inline", "Form submission (c): simulated send success (?mock=success-inline), success message"],
        ] as const;
        for (const [mode, title] of runs) {
          if (left() < 4 * 60 * 1000) { sections.push({ title, phrases: [], end: `not run: only ${Math.round(left() / 60000)} min of the test timeout left` }); continue; }
          try {
            const n0 = (await formLog()).length;
            await page.goto(`${ORIGIN}/contact-us?mock=${mode}`, { waitUntil: "load" });
            await page.waitForTimeout(3000);
            await back();
            const f = await visibleForm();
            await f.locator("input[type='text']").first().fill(FAKE.name);
            await f.locator("input[type='email']").first().fill(FAKE.email);
            await f.locator("input[type='tel']").first().fill(FAKE.phone);
            await f.locator("textarea:not(.g-recaptcha-response)").first().fill(FAKE.message);
            await page.waitForTimeout(1500);
            await submitOf(f).focus();
            await page.waitForTimeout(800);
            const phrases: string[] = [];
            phrases.push(await cap(() => voiceOver.press("Enter", { capture: false })));
            await listen(phrases);
            const st = await formState();
            const posted = (await formLog()).slice(n0);
            const last = posted[posted.length - 1];
            const vals = Object.values(last?.fields ?? {}) as string[];
            const notes = [
              `Fields filled with fake data (Name "${FAKE.name}", Email ${FAKE.email}, Phone ${FAKE.phone}, Message "${FAKE.message}"); focus moved to Send Message; Enter pressed with VoiceOver running.`,
              `Phrase 1: Enter on Send Message; phrases 2+: announcements in the 9 s after the submission (distinct phrases only).`,
              `DOM after the submission: focus on ${st.active}; send-error box ${boxText(st.errorBox)}; success box ${boxText(st.successBox)}; visible role=alert/status/aria-live regions: ${st.alerts.join(" | ") || "none"}; page ${page.url()}.`,
              `Staging form mock: ${posted.length} request(s) for this submission${last ? `, answered "${last.result}" (HTTP ${last.result === "error" ? 500 : 200}; ${last.resultSource}); fake values received: ${[FAKE.name, FAKE.email, FAKE.phone, FAKE.message].every((v) => vals.includes(v)) ? "all 4" : "not all"}; reCAPTCHA field: ${vals.includes("ada-simulated-token") ? "stub token" : "absent"}` : ""}. reCAPTCHA test stub active: ${st.stub ? "yes" : "no"}.`,
              SIM,
            ];
            sections.push({ title, phrases: phrases.filter(Boolean), end: "scenario complete", notes });
          } catch (e) { sections.push({ title, phrases: [], end: `error: ${String(e).slice(0, 160)}` }); }
          flush();
        }
        const sent = (await formLog()).slice(log0);
        sections.push({ title: "Form submission: record of the simulated sends", phrases: [], end: "summary", notes: [
          `${sent.length} request(s) reached the staging server's form mock during this scenario (${sent.map((x) => x.result).join(", ") || "none"}); none was forwarded.`,
          SIM,
        ] });
      };

      if (formHere) {
        if (left() < 8 * 60 * 1000) sections.push({ title: "Form submission (not run)", phrases: [], end: `only ${Math.round(left() / 60000)} min of the test timeout left` });
        else await formScenario();
      }

      const spoken: string[] = await voiceOver.spokenPhraseLog().catch(() => [] as string[]);
      const total = sections.reduce((a, s) => a + s.phrases.length, 0);
      flush(spoken);
      await testInfo.attach(`voiceover-${pg.slug}-${browserName}`, { path: file, contentType: "text/plain" });
      expect(total).toBeGreaterThan(10);
    });
  }
});
