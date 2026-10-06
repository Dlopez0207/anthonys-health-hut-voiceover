#!/usr/bin/env bash
# Downloads every artifact of a VoiceOver workflow run and places the transcripts in results/<slug>/.
# Usage: bash collect.sh <run-id>
set -e
run="$1"; repo="Dlopez0207/anthonys-health-hut-voiceover"
cd "$(dirname "$0")"
rm -rf results-raw/run-$run && mkdir -p results-raw/run-$run
gh run download "$run" -R "$repo" -D results-raw/run-$run
find results-raw/run-$run -path "*/transcripts/*" -name "voiceover-transcript-*.txt" | while read -r f; do
  slug=$(basename "$(dirname "$f")"); mkdir -p "results/$slug"; cp "$f" "results/$slug/"; echo "results/$slug/$(basename "$f")  $(grep -m1 '^Frases' "$f")"
done
