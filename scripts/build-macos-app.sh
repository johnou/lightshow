#!/bin/sh
set -eu
if [ "$(uname -s)" != Darwin ]; then
  echo "Building the Mac app requires macOS." >&2
  exit 1
fi
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
node_bin=$(command -v node)
venv=${LIGHTSHOW_LEDFX_VENV:-"$repo/.lightshow-tools/ledfx-venv"}
if [ ! -x "$venv/bin/python" ]; then
  echo "LedFx is missing. Run npm run setup:ledfx first." >&2
  exit 1
fi
python_base=$("$venv/bin/python" -c 'import sys; print(sys.base_prefix)')
python_site=$("$venv/bin/python" -c 'import sysconfig; print(sysconfig.get_path("purelib"))')
work=$(mktemp -d "${TMPDIR:-/tmp}/lightshow-build.XXXXXX")
trap 'rm -rf "$work"' EXIT
app="$work/Lightshow.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" "$work/AppIcon.iconset"
cp "$repo/macos/Info.plist" "$app/Contents/Info.plist"
cp "$repo/package.json" "$repo/LICENSE" "$repo/server.js" "$repo/show-runner.js" "$repo/music-player.js" "$repo/system-audio.js" "$repo/beat-detector.js" "$repo/music-energy.js" "$repo/ledfx-engine.js" "$repo/govee-stream.js" "$repo/hue-entertainment.js" "$repo/mac-helpers.js" "$repo/youtube-links.js" "$repo/light-selection.js" "$app/Contents/Resources/"
cp -R "$repo/public" "$app/Contents/Resources/public"
cp -R "$repo/node_modules" "$app/Contents/Resources/node_modules"
cp -R "$python_base" "$app/Contents/Resources/ledfx-python"
mkdir -p "$app/Contents/Resources/ledfx-python/lib/python3.11/site-packages"
cp -R "$python_site/." "$app/Contents/Resources/ledfx-python/lib/python3.11/site-packages/"
"$app/Contents/Resources/ledfx-python/bin/python3.11" -m ledfx --version
printf '%s\n' "$repo" > "$app/Contents/Resources/legacy-path.txt"
cp -L "$node_bin" "$app/Contents/MacOS/node"
cp "$repo/macos/Lightshow.swift" "$work/main.swift"
swiftc -module-cache-path "$work/module-cache" -swift-version 5 -target "$(uname -m)-apple-macosx13.0" -O "$work/main.swift" "$repo/macos/system-audio.swift" "$repo/macos/media-key.swift" -o "$app/Contents/MacOS/Lightshow"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$repo/public/icon-512.png" --out "$work/AppIcon.iconset/icon_${size}x${size}.png" >/dev/null
  if [ "$size" -lt 512 ]; then
    double=$((size * 2))
    sips -z "$double" "$double" "$repo/public/icon-512.png" --out "$work/AppIcon.iconset/icon_${size}x${size}@2x.png" >/dev/null
  else
    cp "$repo/public/icon-512.png" "$work/AppIcon.iconset/icon_512x512@2x.png"
  fi
done
iconutil -c icns "$work/AppIcon.iconset" -o "$app/Contents/Resources/AppIcon.icns"
codesign --force --sign - --identifier it.johno.lightshow.node "$app/Contents/MacOS/node"
codesign --force --sign - "$app"
codesign --verify --deep --strict "$app"
destination=${LIGHTSHOW_APP_OUTPUT:-"$repo/Lightshow.app"}
rm -rf "$destination"
mv "$app" "$destination"
printf '\nBuilt %s\n' "$destination"
