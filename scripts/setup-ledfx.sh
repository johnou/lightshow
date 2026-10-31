#!/bin/sh
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
python=${LIGHTSHOW_LEDFX_PYTHON:-python3.11}
runtime="$repo/.lightshow-tools/ledfx-venv"
"$python" -m venv "$runtime"
"$runtime/bin/python" -m pip install -r "$repo/scripts/ledfx-requirements-macos.txt"
"$runtime/bin/python" -m ledfx --version
printf '\nLedFx installed in %s\n' "$runtime"
