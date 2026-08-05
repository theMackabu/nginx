set -euo pipefail
cd "$(dirname "$0")"

if [ "${1:-}" = "--reconfigure" ]; then
    rm -rf build-wasm ../objs-wasm
fi

if [ ! -d build-wasm ]; then
    meson setup build-wasm --cross-file meson/emscripten.ini
fi

meson compile -C build-wasm
