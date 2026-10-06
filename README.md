# VoiceOver (macOS) baseline transcripts — anthonyshealthhutlakeland.com

Real macOS VoiceOver sessions (not an emulator) on GitHub Actions `macos-15` runners, driven with Guidepup +
Playwright, against the published site before any accessibility remediation. Each run saves the literal
transcript of what VoiceOver spoke per page (read-through, headings, landmarks, Tab order) plus a browser video.

Run: Actions → "VoiceOver transcripts (anthonyshealthhutlakeland.com baseline)" → Run workflow.
Collect: `bash collect.sh <run-id>` → `results/<slug>/voiceover-transcript-<browser>.txt`.
