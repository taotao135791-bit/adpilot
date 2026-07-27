#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
package_dir="$repo_root/native/macos-helper"

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
printf '%s\n' "$output_dir/adpilot-native-helper"
