#!/usr/bin/env bash
# Downloads a spread of AI / AI-safety papers and installs the audit harness, so
# extraction changes can be checked against real layouts rather than one lucky PDF.
# Usage:  ./tools/check-extraction.sh   then open the app and run in the console:
#   await import('/_audit.js'); console.table(await __audit(['attention','bert', ...]))
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p app/_papers

papers=(
  "1706.03762:attention"              # NeurIPS, single column
  "1810.04805:bert"                   # ACL, two column
  "1512.03385:resnet"                 # CVPR, two column
  "1606.06565:concrete-problems"      # arXiv, small-type abstract
  "2212.08073:constitutional-ai"      # long, appendices after references
  "2401.05566:sleeper-agents"         # 70pp, heavy figures
  "1811.07871:reward-modeling"        # unnumbered headings
  "1906.01820:learned-optimization"   # has a table of contents
)

for entry in "${papers[@]}"; do
  id="${entry%%:*}"; name="${entry##*:}"
  [ -f "app/_papers/$name.pdf" ] || curl -sL -m 120 -o "app/_papers/$name.pdf" "https://arxiv.org/pdf/$id" &
done
wait

cp tools/audit.js app/_audit.js
echo "papers in app/_papers, harness at app/_audit.js (both git-ignored)"
