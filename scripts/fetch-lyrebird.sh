#!/usr/bin/env bash
# Downloads the current Tor Browser, verifies its signature against the Tor Browser
# Developers key, and copies lyrebird (the bridge program) into bin/. Used by the
# release workflow so packaged builds can connect through bridges.
set -euo pipefail
cd "$(dirname "$0")/.."
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

version=$(curl -sSf https://aus1.torproject.org/torbrowser/update_3/release/downloads.json | node -pe 'JSON.parse(require("fs").readFileSync(0)).version')
case "$(uname)" in
  Darwin) file="tor-browser-macos-$version.dmg" ;;
  Linux)  file="tor-browser-linux-x86_64-$version.tar.xz" ;;
  *) echo "unsupported OS" >&2; exit 1 ;;
esac
url="https://dist.torproject.org/torbrowser/$version/$file"
echo "Tor Browser $version: $file"
curl -sSfL -o "$work/$file" "$url"
curl -sSfL -o "$work/$file.asc" "$url.asc"

export GNUPGHOME="$work/gnupg"; mkdir -m 700 "$GNUPGHOME"
gpg --batch --auto-key-locate nodefault,wkd --locate-keys torbrowser@torproject.org
gpg --batch --status-fd 1 --verify "$work/$file.asc" "$work/$file" | grep -qE '^\[GNUPG:\] VALIDSIG .* EF6E286DDA85EA2A4BA7DE684E2C6E8793298290$'
echo "Signature OK (Tor Browser Developers)"

if [ "$(uname)" = Darwin ]; then
  hdiutil attach -nobrowse -readonly -mountpoint "$work/mnt" "$work/$file" >/dev/null
  node scripts/bridges-setup.js "$work/mnt/Tor Browser.app"
  hdiutil detach "$work/mnt" >/dev/null
else
  tar -xJf "$work/$file" -C "$work"
  node scripts/bridges-setup.js "$work/tor-browser/Browser/TorBrowser/Tor/PluggableTransports/lyrebird"
fi
