#!/bin/bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
case "$(uname -m)" in
  arm64) EXECUTABLE="$ROOT/bin/sevokecode-image-gen-macos-arm64" ;;
  x86_64) EXECUTABLE="$ROOT/bin/sevokecode-image-gen-macos-x64" ;;
  *) echo "Unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;;
esac
exec "$EXECUTABLE" install
