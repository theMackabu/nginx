#!/bin/bash

set -euo pipefail

NGINX_ROOT=$1
MESON_OUT=$2
PCRE2_LIB=$3
ZLIB_LIB=$4
SSL_LIB=$5
CRYPTO_LIB=$6
PCRE2_VER=$7
ZLIB_VER=$8
OPENSSL_VER=$9

WASM_DIR="$NGINX_ROOT/wasm"
EMCC="${EMCC:-emcc}"

mkdir -p "$WASM_DIR/dist"

OBJS=$(find "$NGINX_ROOT/objs-wasm" -name '*.o' | sort)

NGXW_OPT="${NGXW_OPT:--O3}"

"$EMCC" $OBJS "$PCRE2_LIB" "$ZLIB_LIB" "$SSL_LIB" "$CRYPTO_LIB" \
    -o "$WASM_DIR/dist/nginx.mjs" \
    $NGXW_OPT \
    -sMODULARIZE=1 \
    -sEXPORT_ES6=1 \
    -sEXPORT_NAME=createNginxModule \
    -sINVOKE_RUN=0 \
    -sALLOW_MEMORY_GROWTH=1 \
    -sWASM_BIGINT=0 \
    -sSTACK_SIZE=1048576 \
    -sERROR_ON_UNDEFINED_SYMBOLS=0 \
    --embed-file "$NGINX_ROOT/conf/mime.types@/nginxw/conf/mime.types" \
    -lnodefs.js \
    -sEXPORTED_FUNCTIONS=_nginxw_init,_nginxw_accept,_nginxw_push,_nginxw_push_dgram,_nginxw_eof,_nginxw_conn_ready,_nginxw_conn_error,_nginxw_out_size,_nginxw_out_take,_nginxw_debug_conn,_nginxw_tick,_nginxw_writable,_nginxw_in_size,_nginxw_listen_count,_nginxw_listen_port,_nginxw_reload,_nginxw_describe,_nginxw_js_finish,_nginxw_js_send_head,_nginxw_js_send_chunk,_nginxw_js_send_end,_nginxw_js_fail,_nginxw_js_access_finish,_nginxw_req_method,_nginxw_req_uri,_nginxw_req_headers,_nginxw_req_var,_nginxw_req_body_len,_nginxw_req_body_copy,_malloc,_free \
    -sEXPORTED_RUNTIME_METHODS=FS,ccall,cwrap,HEAPU8,UTF8ToString,stringToUTF8,lengthBytesUTF8

NGINX_VER=$(sed -n 's/#define NGINX_VERSION *"\(.*\)"/\1/p' "$NGINX_ROOT/src/core/nginx.h")
EMCC_VER=$("$EMCC" --version | sed -n '1s/.*) \([0-9.]*\).*/\1/p')
cat > "$WASM_DIR/js/version.js" <<EOF

export default {
  nginx: '$NGINX_VER',
  pcre2: '$PCRE2_VER',
  zlib: '$ZLIB_VER',
  openssl: '$OPENSSL_VER',
  emscripten: '$EMCC_VER',
};
EOF

cp "$WASM_DIR/dist/nginx.mjs" "$MESON_OUT"

echo "Built $WASM_DIR/dist/nginx.mjs (nginx $NGINX_VER, pcre2 $PCRE2_VER, zlib $ZLIB_VER, openssl $OPENSSL_VER)"
