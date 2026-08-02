#!/usr/bin/env bash
# Copies the web app into the extension so both ship the same reader.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf extension/app
mkdir -p extension/app
rsync -a --exclude 'sw.js' --exclude '_test*' app/ extension/app/

echo "extension/app updated — load ./extension as an unpacked extension"
