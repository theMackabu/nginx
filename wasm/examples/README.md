# Examples

Run these directly from the repository root after building nginx-wasm:

| Example               | Command                                      | Behavior                                                           |
| --------------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| Config routing        | `node wasm/examples/routing.js`              | Exercises in-process routing and exits after checking the results  |
| TCP server smoke test | `node wasm/examples/server-smoke.js`         | Serves real requests, checks static files and proxying, then exits |
| HTTP dev server       | `node wasm/examples/serve.js [port]`         | Runs until Ctrl-C                                                  |
| HTTPS dev server      | `node wasm/examples/serve-tls.js [port]`     | Terminates TLS and runs until Ctrl-C                               |
| Composed routing      | `node wasm/examples/compose.js`              | Exercises code-based routing and exits after checking the results  |
| Composed server       | `node wasm/examples/compose-serve.js [port]` | Runs a code-based server until Ctrl-C                              |

The long-running server examples serve static files from `public/`.
