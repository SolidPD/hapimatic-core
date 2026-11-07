#!/usr/bin/env bash
# vendor-git-lfs-archives-v1.sh — rebuild cli/tools/archives/git-lfs-<platform>.tar.gz from the upstream release (#6223).
#
# Each download is checked against the sha256 upstream published in the release's sha256sums.asc, pinned below. Only the
# binary is kept, at git-lfs-bin/git-lfs (git-lfs.exe on Windows), so that one folder can go on PATH without rg and difft.
# The tar is deterministic: rerunning reproduces the bytes pinned in ARCHIVE_SHA256 (scripts/generate-sbom-v1.ts).
#
# On a version bump: update VER and every pin from the new sha256sums.asc, run this, update ARCHIVE_SHA256 and the SBOM
# entry's version, then run `bun run gen:sbom`.
#
# Exit: 0 = all archives written · 1 = a download, checksum or packaging step failed.
set -euo pipefail
echo "vendor-git-lfs-archives v1"

VER=3.8.1
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
OUT="$ROOT/cli/tools/archives"
BASE="https://github.com/git-lfs/git-lfs/releases/download/v$VER"

# <our platform dir> <upstream asset> <upstream sha256>
ASSETS=(
    "arm64-darwin git-lfs-darwin-arm64-v$VER.zip 0ba10e897e0496412cd86eacaed4ed554c97ddc29bc5c709d28faa5eaaa2222c"
    "x64-darwin git-lfs-darwin-amd64-v$VER.zip 4292b3518e717e53c20a6c2c0696e2069a21e97500ad14b80b06bd52de8f3b72"
    "arm64-linux git-lfs-linux-arm64-v$VER.tar.gz 67895dd77b63329796bc5efdd47b57f218e1f7b98717ebaf936a8238dbcaec0f"
    "x64-linux git-lfs-linux-amd64-v$VER.tar.gz e72cf723a4a660438862282e8aecf3885fc8123e88bfcad534cf6b941a354b75"
    "x64-win32 git-lfs-windows-amd64-v$VER.zip 5bb771c12b3dacc535e912d0270a010c209d4da2e63819c5918e3547c2defed9"
)

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

for row in "${ASSETS[@]}"; do
    read -r platform asset want <<<"$row"
    dir="$WORK/$platform"
    mkdir -p "$dir/dl" "$dir/x" "$dir/pkg/git-lfs-bin"
    curl -fsSL -o "$dir/dl/$asset" "$BASE/$asset"
    got=$(sha256sum "$dir/dl/$asset" | cut -d' ' -f1)
    [ "$got" = "$want" ] || { echo "checksum mismatch for $asset: $got != $want" >&2; exit 1; }
    case "$asset" in
        *.zip) unzip -q "$dir/dl/$asset" -d "$dir/x" ;;
        *) tar -xzf "$dir/dl/$asset" -C "$dir/x" ;;
    esac
    bin=git-lfs
    [ "$platform" = x64-win32 ] && bin=git-lfs.exe
    install -m 755 "$(find "$dir/x" -type f -name "$bin" | head -1)" "$dir/pkg/git-lfs-bin/$bin"
    tar --sort=name --owner=0 --group=0 --numeric-owner --mtime='2026-01-01 00:00:00Z' \
        -C "$dir/pkg" -cf - git-lfs-bin | gzip -9n > "$OUT/git-lfs-$platform.tar.gz"
    printf '%s %s %s bytes\n' "$(sha256sum "$OUT/git-lfs-$platform.tar.gz" | cut -d' ' -f1)" "git-lfs-$platform.tar.gz" "$(wc -c < "$OUT/git-lfs-$platform.tar.gz")"
done
