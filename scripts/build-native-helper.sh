#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
package_dir="$repo_root/native/macos-helper"
staged_root="$repo_root/build/native-helper"
staged_app="$staged_root/AdPilot Computer Helper.app"
staged_contents="$staged_app/Contents"
staged_binary="$staged_contents/MacOS/adpilot-native-helper"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "native macOS helper build skipped on non-Darwin host" >&2
  exit 0
fi

if [[ $# -gt 1 ]]; then
  echo "usage: $0 [output-directory]" >&2
  exit 64
fi

if [[ $# -eq 1 ]]; then
  if [[ "$1" = /* ]]; then
    output_dir="$1"
  else
    output_dir="$repo_root/$1"
  fi
else
  output_dir="$package_dir/dist"
fi

swift build --package-path "$package_dir" --configuration release >&2
binary_dir="$(swift build --package-path "$package_dir" --configuration release --show-bin-path)"
source_binary="$binary_dir/adpilot-native-helper"

if [[ ! -x "$source_binary" ]]; then
  echo "native helper build did not produce an executable" >&2
  exit 70
fi

mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd -P)"
install -m 0755 "$source_binary" "$output_dir/adpilot-native-helper"

app_version="$(
  node -e '
    const manifest = require(process.argv[1]);
    if (typeof manifest.version !== "string" || !/^[0-9]+(?:\.[0-9]+){1,3}$/.test(manifest.version)) {
      throw new Error("package.json version is not a valid macOS bundle version");
    }
    process.stdout.write(manifest.version);
  ' "$repo_root/package.json"
)"

# Stage one clearly named nested helper application. The packaged Electron app
# launches this exact executable; no second loose helper binary is copied into
# Resources, so macOS permission ownership remains unambiguous.
rm -rf "$staged_app"
install -d -m 0755 "$staged_contents/MacOS"
install -d -m 0755 "$staged_contents/Resources"
install -m 0755 "$source_binary" "$staged_binary"
install -m 0644 "$package_dir/Resources/Info.plist" "$staged_contents/Info.plist"
/usr/libexec/PlistBuddy \
  -c "Set :CFBundleShortVersionString $app_version" \
  -c "Set :CFBundleVersion $app_version" \
  "$staged_contents/Info.plist"

# A development build has no Developer ID, but ad-hoc signing still seals the
# helper and gives Security.framework a stable bundle/signing identifier.
codesign \
  --force \
  --options runtime \
  --timestamp=none \
  --sign - \
  "$staged_app" >&2

echo "staged helper app: $staged_app" >&2
printf '%s\n' "$output_dir/adpilot-native-helper"
