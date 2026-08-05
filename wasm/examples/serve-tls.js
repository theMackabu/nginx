import { createServer } from "node:http";
import { Nginx } from "../js/index.js";

const PORT = parseInt(process.argv[2] || "8443", 10);

const CERT = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIUYATMiZcrnm94bVdB9p0hvi7HVzEwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDcyMjIzMjQyN1oYDzIxMjYw
NjI4MjMyNDI3WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCmMQ/AM+K1lna5PJqIWTlpkaU9DItpMiRN3LIr1jQU
4SAIUH+iuUaH2LLYF7FE1kh68bAcDD3q3EZXgIQIEx6rbCevS1xPO/nVXvDvri19
uM5MvJrlG7kP51u1IVvbDBR9kJZVealjd+91Rqo1QaQ+pyeir47+vW4dFAp8VZc5
CsC46WpDsO9MmcgFIWab264GHYgQ4ZCMn8HNOZHmu6+kswQGK6hauboWCxGS9SBC
C19yOxy4HTqrGPe55pcT9zehwxlaFN08rPwkONr0Gh2NeLm0lacjYxSIYAFKlDiQ
CLk2kIKobbyiVf/9y7yo0EAMPST056B+Zl3qBjsu2A3BAgMBAAGjbzBtMB0GA1Ud
DgQWBBQQzwelqLh1s840GMgUYyi+eT8C1zAfBgNVHSMEGDAWgBQQzwelqLh1s840
GMgUYyi+eT8C1zAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGCCWxvY2FsaG9z
dIcEfwAAATANBgkqhkiG9w0BAQsFAAOCAQEAoSPoubc86lFeSBSIry46kNx2cRyL
A5UK14CeRfz203vd7pp+ZHHlQwpkMb0h3qAfSlu1fXhDfcOnEgx5GcHk4SBiKjj5
3j2kAUBZtEKAN+UuFTXo6bbDyaCgNa1cRyOC0tKtYSUbNIB9EfrrVQWly5UH1gkj
uRKmKcSeFI/h2x3skh++03ULQ5cyYSvJJObAyRs9pCTZ6EA2GL1SMPLy5+u8ruC/
Swc9ixMkeGuwJsrR627/nNbfYKHrJIxw58TCmGVRmbI+WXPSFIpkqr1CbDF1bB1Y
GAAnPk/gZxBRvailleJS6frb4Pe34bmN7JaoHhOOnhgA0s6E2ntqcKPzhw==
-----END CERTIFICATE-----
`;
const KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCmMQ/AM+K1lna5
PJqIWTlpkaU9DItpMiRN3LIr1jQU4SAIUH+iuUaH2LLYF7FE1kh68bAcDD3q3EZX
gIQIEx6rbCevS1xPO/nVXvDvri19uM5MvJrlG7kP51u1IVvbDBR9kJZVealjd+91
Rqo1QaQ+pyeir47+vW4dFAp8VZc5CsC46WpDsO9MmcgFIWab264GHYgQ4ZCMn8HN
OZHmu6+kswQGK6hauboWCxGS9SBCC19yOxy4HTqrGPe55pcT9zehwxlaFN08rPwk
ONr0Gh2NeLm0lacjYxSIYAFKlDiQCLk2kIKobbyiVf/9y7yo0EAMPST056B+Zl3q
Bjsu2A3BAgMBAAECggEAEX0m5oJkoINdqbn3m9L34w97+g6wj7jCb/HXoMar4xPw
e6+CSazW/+4NSVxE6rTkxRCwsw2UE9EWaJg89187t60WsrBq3b5hWNONkKDIZ2s5
RS4GhtxXVJXI5X4bMn6fnA8eeDmTWm+r+AV1sqEJGGbIGatWkEwoTaW8QhVSZ/gj
+6rSs87+Zc0HA58jXXIO95j/59f33YxSZCsIegSsp5MvlIhTk/7p441HCaKEBhuz
yhVjUVb8jiLSebL7xT48AlAN/4WHXIp3gsWfU2faMPeGs+pi8AhT8qkZii0VIKna
hLffe598E/pbhOIFqZcJbN2hvTcEck2bRaeoxWjkGQKBgQDowhiAQtsXxaVCPGhQ
WZZ3pF8zmGe5J3Xm+xZl4GFeTg/+M41m2ef5B+PIagsr/qh4MDXhePnWWY+PRgSI
MGJ6s0HrH0vuaeAsdldqizmqDXNcJ6qllIqwEMjwz6bYCt3n2Dc4B/1YPbyUmaDR
lmRfy0Sq7YBmAsU/9XaZzkDMbwKBgQC2yVoeSxwwFtnqNHy+Y1P4er0JbvQMl8M7
+zAjy3am5tbSwcT6youA+E8H+BTTzDfymYEVe0j8PltVIZjaitDmMCdwarYRdzIe
2JNJa8DKej2mkpgMuk1eZHJ1DRSNK/6tGBRj9fnFDAqA+TTlPwmlKdGA7Ss7Oc1n
YU+e6ZlAzwKBgDeU8gje7jbVCcuxZS+a1SWo6NsHT+2VEMChwQ1+8YF1nrgTU3b2
HkEHs0tOl3BgFZbt3FAFdZPMO035aGelNj8aw2kERjueqNu1PtbAfHqxT5T4G/YC
bMPynilzTOJWZftRVI5ayhLiW0AZF6A1C68ceT9gC8NQcg397d54tFydAoGBAIFU
2OnkVU6FbKz1dGo1171SAx2AnzelziNLqRU6qnqPjOLU7e5RkAGyMCFAXGQ79D44
dQhhEhRAftkui3veis7EtbMqHicfgpwmu5hQoLnjYmnRAbrHu2SViBLgLXFx9qI9
DnhoG9Fborb9HXszbjyp6S3jIhqm3HpQdUjImoIrAoGBAIAPtpTOp2H2Z8R2v0O7
FBHVh0i9cDiXqdTJlJq0YfzacYuPAMjABUuHZ2JogHzjwS1uhWoTewl0SVNpAskt
UP8hbyRMg9VTOhIV004J+p95p+mqfkr4UqG2Kyt+9mwle1ldnrME99mWc/JYp0I+
NeqQ+tNOd80fO6Hm7Y/c3Xpw
-----END PRIVATE KEY-----
`;

const backend = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ via: "backend", path: req.url, tls: "terminated by nginx-wasm" }));
});
await new Promise((r) => backend.listen(0, "127.0.0.1", r));
const backendPort = backend.address().port;

const nginx = await Nginx.create(
  `
  upstream app { server 127.0.0.1:${backendPort}; keepalive 4; }

  server {
    listen 443 ssl;
    http2 on;
    server_name localhost;

    ssl_certificate     /tls/cert.pem;
    ssl_certificate_key /tls/key.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    root /var/www/html;
    gzip on;

    location = /health { return 200 "ok\\n"; }
    location /api/ {
      proxy_pass http://app;
      proxy_http_version 1.1;
      proxy_set_header Connection "";
    }
    location / { }
  }
  `,
  {
    files: { "/tls/cert.pem": CERT, "/tls/key.pem": KEY },
    mounts: { "/var/www/html": new URL("./public", import.meta.url).pathname },
    logLevel: "warn",
  }
);

const server = await nginx.serve({ port: PORT, nginxPort: 443 });

console.log(`
  nginx-wasm ${Nginx.versions.nginx} + OpenSSL ${Nginx.versions.openssl} — HTTPS on https://127.0.0.1:${PORT}

    curl -k https://127.0.0.1:${PORT}/health          return 200 over TLS
    curl -k https://127.0.0.1:${PORT}/api/thing        proxied to the backend
    curl -k https://127.0.0.1:${PORT}/                 static index (live from wasm/examples/public/)
    curl -k --http2 -sI https://127.0.0.1:${PORT}/     ALPN negotiates h2

  real TLS handshake terminated inside WebAssembly. -k because the cert is self-signed.
  Ctrl-C to stop.
`);

process.on("SIGINT", () => {
  console.log("\nshutting down");
  server.close();
  backend.close();
  nginx.dispose();
  process.exit(0);
});
