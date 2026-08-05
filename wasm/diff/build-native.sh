#!/bin/bash

set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${1:-}" = "--force" ]; then
  rm -rf build-native ../objs-native
elif [ -x ../objs-native/nginx ]; then
  echo "native nginx already built: objs-native/nginx"
  exit 0
fi

if [ ! -d build-native ]; then
  meson setup build-native
fi

meson compile -C build-native

../objs-native/nginx -v
