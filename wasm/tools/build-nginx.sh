#!/bin/bash

set -euo pipefail

MODE=$1
NGINX_ROOT=$2
STAMP=$3
PCRE2_LIB=$4
ZLIB_LIB=$5
SSL_LIB=$6
CRYPTO_LIB=$7

WASM_DIR="$NGINX_ROOT/wasm"
JOBS=$(sysctl -n hw.ncpu 2>/dev/null || nproc)

STAMP="$(cd "$(dirname "$STAMP")" && pwd)/$(basename "$STAMP")"

LIBDIR=$(dirname "$STAMP")/libs-$MODE
mkdir -p "$LIBDIR"
ln -sf "$PCRE2_LIB" "$LIBDIR/libpcre2-8.a"
ln -sf "$ZLIB_LIB" "$LIBDIR/libz.a"
ln -sf "$SSL_LIB" "$LIBDIR/libssl.a"
ln -sf "$CRYPTO_LIB" "$LIBDIR/libcrypto.a"

pcre2_name=$(basename "$(dirname "$PCRE2_LIB")")
zlib_name=$(basename "$(dirname "$ZLIB_LIB")")
ssl_name=$(basename "$(dirname "$SSL_LIB")")
INC="-I$(dirname "$PCRE2_LIB") -I$WASM_DIR/subprojects/$pcre2_name/src"
INC="$INC -I$(dirname "$ZLIB_LIB") -I$WASM_DIR/subprojects/$zlib_name"

if [ "$MODE" = wasm ]; then
    SSL_ARCH=linux-elf
else
    case "$(uname -s):$(uname -m)" in
        Darwin:arm64)  SSL_ARCH=darwin64-arm64-cc ;;
        Darwin:x86_64) SSL_ARCH=darwin64-x86_64-cc ;;
        Linux:aarch64) SSL_ARCH=linux-aarch64 ;;
        *)             SSL_ARCH=linux-x86_64 ;;
    esac
fi
INC="$INC -I$WASM_DIR/subprojects/$ssl_name/generated-config/archs/$SSL_ARCH/no-asm/include"
INC="$INC -I$WASM_DIR/subprojects/$ssl_name/include"

cd "$NGINX_ROOT"

COMMON_FLAGS=(
    --with-http_ssl_module
    --with-http_v2_module
    --with-http_auth_request_module
    --without-http_ssi_module
    --without-http_auth_basic_module
    --without-http_fastcgi_module
    --without-http_uwsgi_module
    --without-http_scgi_module
    --without-http_grpc_module
    --without-http_memcached_module
)

if [ "$MODE" = wasm ]; then
    BUILDDIR=objs-wasm
    export EMCC="${EMCC:-emcc}"
    export NODE_BIN="${NODE_BIN:-$(command -v node)}"

    if [ ! -f "$BUILDDIR/Makefile" ]; then
        CC="$WASM_DIR/tools/emcc-wrap" auto/configure \
            --crossbuild=wasm32 \
            --builddir="$BUILDDIR" \
            --prefix=/nginxw/ \
            --with-cc="$WASM_DIR/tools/emcc-wrap" \
            --with-cc-opt="-Wno-sign-compare $INC" \
            --with-ld-opt="-L$LIBDIR" \
            --with-debug \
            --with-select_module \
            --add-module="$WASM_DIR/shim" \
            "${COMMON_FLAGS[@]}"
    fi
else
    BUILDDIR=objs-native

    if [ ! -f "$BUILDDIR/Makefile" ]; then
        auto/configure \
            --builddir="$BUILDDIR" \
            --prefix=/tmp/nginx-native-unused \
            --with-cc-opt="$INC" \
            --with-ld-opt="-L$LIBDIR" \
            "${COMMON_FLAGS[@]}"
    fi
fi

make -f "$BUILDDIR/Makefile" -j"$JOBS"

touch "$STAMP"
