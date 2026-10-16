# VoiceOver (macOS) baseline transcripts — anthonyshealthhutlakeland.com

Real macOS VoiceOver sessions (not an emulator) on GitHub Actions `macos-15` runners, driven with Guidepup +
Playwright, against the published site before any accessibility remediation. Each run saves the literal
transcript of what VoiceOver spoke per page (read-through, headings, landmarks, Tab order) plus a browser video.

Run: Actions → "VoiceOver transcripts (anthonyshealthhutlakeland.com baseline)" → Run workflow.
Collect: `bash collect.sh <run-id>` → `results/<slug>/voiceover-transcript-<browser>.txt`.

## Retest v1.2.1 (2026-10-16)

`target=retest` serves the corrected copy on the runner from the committed snapshot (`fixed/staging/cache`,
`server.mjs --offline`: no request to the published site) with Head HTML v1.2.1 (SHA-256 `8767b787…`, checked by the
workflow). Full read-through (read_scale 1, step caps above each page's length, 40-min read budget), test timeout
75 min, job 90 min. `/contact-us` adds a "Form submission" scenario (empty submit; simulated send failure with
`?mock=error`; simulated success with `?mock=success-inline`): no message is sent (the staging server's local form
mock answers) and Google reCAPTCHA is replaced by a test-only stub in that scenario only.
The committed snapshot differs from the project's local cache in one string only: Duda's runtime property
`common.mapbox.token` (a public Mapbox token present in every published page) is replaced with a placeholder, because
GitHub push protection blocks it; no Mapbox map is used on the tested pages.
