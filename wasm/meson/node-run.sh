#!/bin/sh

f="$1"
shift

case "$f" in
    *.js | *.mjs | *.cjs)
        exec node "$f" "$@"
        ;;
    *)
        cp -f "$f" "$f.cjs"
        exec node "$f.cjs" "$@"
        ;;
esac
