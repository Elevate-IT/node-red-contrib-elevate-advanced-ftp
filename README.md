# node-red-contrib-elevate-advanced-ftp

A Node-RED node for advanced FTP operations, with extended runtime control and logging capabilities.

> 🛠️ Forked and maintained by [Elevate IT](https://github.com/Elevate-IT), based on the original work by [anversoft](https://github.com/anversoft/node-red-contrib-advanced-ftp).

---

## ✨ What's New in This Fork?

This fork introduces a new operation:

### ✅ `PUTRENAME`

A convenient one-step action that first uploads a file (`PUT`) and immediately renames it on the server (`RENAME`). This is especially useful for workflows where you want to avoid processing partially uploaded files on the server.

---

## 📦 Installation

### Using npm:

Run the following in your Node-RED user directory (usually `~/.node-red`):

```bash
npm install node-red-contrib-elevate-advanced-ftp
```

Then restart Node-RED.

### Using the Node-RED Palette:

- Open Node-RED
- Go to **Menu → Manage palette → Install**
- Search for `node-red-contrib-elevate-advanced-ftp` and install

---

## ⚙️ Usage

The node supports a variety of FTP operations. These can be set either statically in the editor or dynamically at runtime via `msg.operation`.

### Supported operations:

- `status`
- `pwd`
- `system`
- `list`
- `get`
- `put`
- `append`
- `rename`
- `delete`
- `mkdir`
- `rmdir`
- ✅ `putrename` ← *New!*

You can modify paths, filenames, and other parameters dynamically via `msg` properties.

---

## 🔐 Connection settings, timeouts and FTPS

| Setting | Default | Meaning |
|---|---|---|
| Connection Timeout | 10000 ms | TCP connect only. |
| **Login Timeout** | 10000 ms | From connect until logged in: TCP connect, `220` greeting, TLS handshake, `USER`/`PASS`. On expiry the socket is destroyed and the operation fails with `err.code = 'ETIMEDOUT_READY'`. `0` disables it. |
| **Operation Timeout** | 300000 ms | The operation after login (e.g. the full upload of a PUT). Fails with `err.code = 'ETIMEDOUT_OPERATION'`. `0` disables it. |
| Explicit FTPS (AUTH TLS) | off | `AUTH TLS` on the control connection, `PROT P` for data connections. |
| TLS Options | – | JSON object passed to `tls.connect()`, e.g. `{"rejectUnauthorized": false}` or `{"minVersion": "TLSv1.2"}`. |
| **Allow legacy TLS renegotiation** | off | Needed for servers without RFC 5746 support, which Node.js 18+ rejects with `ERR_SSL_UNSAFE_LEGACY_RENEGOTIATION_DISABLED`. |

The node calls `done()` when the operation has really finished (or failed), so Catch/Complete nodes and
message timing reflect the real FTP work. Each message uses its own connection; `msg.abort = true`
destroys the connections this node still has open.

---

## 🧪 Example Flow

Here's an example of how to use the FTP Client node to perform different FTP operations dynamically:

<details>
<summary>Click to expand example flow JSON</summary>

```json
[PASTE FULL EXAMPLE FLOW JSON HERE]
```

</details>

---

## 🔒 FTP Logger

Also included is an FTP Logger node that periodically logs data to files, rotates them, and uploads to an FTP server.

---

## 🙌 Acknowledgements

This project uses the following libraries:

- [node-ftp](https://github.com/mscdex/node-ftp) – Asynchronous FTP client for Node.js.
- [fs-extra](https://github.com/jprichardson/node-fs-extra) – File system utilities with promise support and enhancements.

---

## 🧪 Tests

```bash
npm test
```

Runs `test/harness.js` against local plain-FTP and explicit-FTPS servers (pyftpdlib), including a server that never sends its greeting and one that stalls after login. Needs Node.js, `openssl` and [uv](https://docs.astral.sh/uv/); uses ports 2121-2125 and 30000-30199 on 127.0.0.1.

---

## 📄 License

Apache License 2.0 – See [LICENSE](https://github.com/Elevate-IT/node-red-contrib-elevate-advanced-ftp/blob/main/LICENSE).

---

## 🤝 Contributing

We welcome issues and pull requests!  
Open an issue or PR at: [https://github.com/Elevate-IT/node-red-contrib-elevate-advanced-ftp/issues](https://github.com/Elevate-IT/node-red-contrib-elevate-advanced-ftp/issues)

---

## 👥 Contributors

Thanks to all contributors past and present!

Original project:  
[![Contributors](https://contrib.rocks/image?repo=anversoft/node-red-contrib-advanced-ftp)](https://github.com/anversoft/node-red-contrib-advanced-ftp/graphs/contributors)

Fork maintained by: [Elevate IT](https://github.com/Elevate-IT)