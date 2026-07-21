#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "$0")/.." && pwd)"
render_dir="$(mktemp -d)"
iconset_dir="$render_dir/AdPilot.iconset"
trap 'rm -rf "$render_dir"' EXIT

mkdir -p "$iconset_dir"
qlmanage -t -s 1024 -o "$render_dir" "$project_dir/build/icon.svg" >/dev/null
rendered_icon="$render_dir/icon.svg.png"

sips -z 16 16 "$rendered_icon" --out "$iconset_dir/icon_16x16.png" >/dev/null
sips -z 32 32 "$rendered_icon" --out "$iconset_dir/icon_16x16@2x.png" >/dev/null
sips -z 32 32 "$rendered_icon" --out "$iconset_dir/icon_32x32.png" >/dev/null
sips -z 64 64 "$rendered_icon" --out "$iconset_dir/icon_32x32@2x.png" >/dev/null
sips -z 128 128 "$rendered_icon" --out "$iconset_dir/icon_128x128.png" >/dev/null
sips -z 256 256 "$rendered_icon" --out "$iconset_dir/icon_128x128@2x.png" >/dev/null
sips -z 256 256 "$rendered_icon" --out "$iconset_dir/icon_256x256.png" >/dev/null
sips -z 512 512 "$rendered_icon" --out "$iconset_dir/icon_256x256@2x.png" >/dev/null
sips -z 512 512 "$rendered_icon" --out "$iconset_dir/icon_512x512.png" >/dev/null
sips -z 1024 1024 "$rendered_icon" --out "$iconset_dir/icon_512x512@2x.png" >/dev/null

iconutil -c icns "$iconset_dir" -o "$project_dir/build/icon.icns"
echo "$project_dir/build/icon.icns"
