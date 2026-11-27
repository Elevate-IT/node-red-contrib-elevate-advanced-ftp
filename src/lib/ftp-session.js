/**
 * Shared connection handling for the advanced-ftp nodes.
 *
 * Wraps one `ftp` (mscdex, 0.3.x) connection so that it always ends, either by
 * an explicit finish() from the node, an error, the server closing the
 * connection or a timeout:
 *
 *  - readyTimeout: from connect() until the `ready` event, i.e. TCP connect,
 *    the 220 greeting, AUTH TLS + handshake and login. The library itself only
 *    guards the TCP connect (connTimeout) and then waits forever for the
 *    greeting, because it uses socket.setTimeout(0).
 *  - operationTimeout: from `ready` until finish().
 *
 * On error or timeout the sockets are destroyed, not ended: ftp's own end() and
 * destroy() only half-close the socket, which does nothing on a hung server.
 */
'use strict';

const Ftp = require('ftp');
const crypto = require('crypto');
const net = require('net');

const DEFAULT_READY_TIMEOUT = 10000;
const DEFAULT_OPERATION_TIMEOUT = 300000;
const GRACEFUL_CLOSE_MS = 5000;

function toMs(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function isTrue(value) {
    return value === true || value === 'true';
}

/**
 * Secure Options used to be a free text field whose value was handed to the
 * library as a string, which then iterated over its characters, so whatever
 * was typed there never reached tls.connect(). Accept a JSON object (or an
 * object passed through msg.options). Anything else is ignored with a warning,
 * which matches how such values behaved before.
 */
function parseSecureOptions(value) {
    if (value === undefined || value === null) return { value: {} };
    if (typeof value === 'object' && !Array.isArray(value)) return { value: Object.assign({}, value) };
    if (typeof value !== 'string') {
        return { value: {}, error: 'Secure Options must be a JSON object; value ignored' };
    }
    const text = value.trim();
    if (text === '') return { value: {} };
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        return { value: {}, error: 'Secure Options is not valid JSON (' + e.message + '); value ignored' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { value: {}, error: 'Secure Options must be a JSON object, e.g. {"rejectUnauthorized": false}; value ignored' };
    }
    return { value: parsed };
}

function addFlag(current, flag) {
    const cur = Number(current) || 0;
    // Avoid 32-bit bitwise operators: some SSL_OP_* values are above 2^31.
    return Math.floor(cur / flag) % 2 === 1 ? cur : cur + flag;
}

/**
 * Build the options object for ftp.connect() from the config node options or
 * from a user-supplied msg.options. Never mutates the input.
 */
function buildConnectOptions(options) {
    const out = Object.assign({}, options || {});
    const parsed = parseSecureOptions(out.secureOptions);
    const tlsOptions = parsed.value;

    if (isTrue(out.allowLegacyRenegotiation)) {
        // Servers without RFC 5746 secure renegotiation are rejected by
        // OpenSSL 3 (Node 18+) with ERR_SSL_UNSAFE_LEGACY_RENEGOTIATION_DISABLED.
        tlsOptions.secureOptions = addFlag(tlsOptions.secureOptions, crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT);
    }
    // SNI; not allowed for IP addresses (RFC 6066).
    if (out.secure && tlsOptions.servername === undefined && out.host && net.isIP(String(out.host)) === 0) {
        tlsOptions.servername = String(out.host);
    }

    out.secureOptions = tlsOptions;
    out.readyTimeout = toMs(out.readyTimeout, DEFAULT_READY_TIMEOUT);
    out.operationTimeout = toMs(out.operationTimeout, DEFAULT_OPERATION_TIMEOUT);
    return { options: out, warning: parsed.error };
}

function timeoutError(message, code) {
    const err = new Error(message);
    err.code = code;
    return err;
}

function destroySocket(sock) {
    if (sock && !sock.destroyed) {
        try { sock.destroy(); } catch (e) { /* ignore */ }
    }
}

const TRACKED_METHODS = ['list', 'listSafe', 'get', 'put', 'append', 'delete', 'rename', 'mkdir', 'rmdir',
    'cwd', 'pwd', 'status', 'system', 'size', 'lastMod', 'site', 'ascii', 'binary'];

/**
 * Open a connection and run one unit of work on it.
 *
 * @param {object} opts
 * @param {object} opts.options       connect options (already passed through buildConnectOptions)
 * @param {function} opts.onReady     (conn, finish) called once logged in; call finish(err?) when done
 * @param {function} opts.onFinish    (err) called exactly once when the session is over
 * @param {boolean} [opts.finishWhenIdle] finish successfully as soon as no command started from
 *                                    onReady is still waiting for its callback (for code that does
 *                                    not reliably call finish()). A server close then also counts as success.
 * @returns {{conn: object, finish: function}}
 */
function startSession(opts) {
    const options = opts.options;
    const conn = new Ftp();
    let finished = false;
    let ready = false;
    let readyTimer = null;
    let opTimer = null;
    let rawSocket = null;
    let pending = 0;

    function clearTimers() {
        clearTimeout(readyTimer);
        clearTimeout(opTimer);
    }

    function hardClose() {
        const sockets = [conn._pasvSocket, conn._pasvSock, conn._socket, rawSocket];
        try { conn.destroy(); } catch (e) { /* ignore */ }
        sockets.forEach(destroySocket);
    }

    function gracefulClose() {
        const sockets = [conn._pasvSocket, conn._socket, rawSocket];
        try { conn.end(); } catch (e) { /* ignore */ }
        // If the server never acknowledges the close, do not keep the socket around.
        const t = setTimeout(function () { sockets.forEach(destroySocket); }, GRACEFUL_CLOSE_MS);
        if (t.unref) t.unref();
    }

    function finish(err) {
        if (finished) return;
        finished = true;
        clearTimers();
        if (err) hardClose(); else gracefulClose();
        opts.onFinish(err);
    }

    if (opts.finishWhenIdle) {
        TRACKED_METHODS.forEach(function (name) {
            const original = conn[name];
            if (typeof original !== 'function') return;
            conn[name] = function () {
                const args = Array.prototype.slice.call(arguments);
                const last = args.length - 1;
                if (last >= 0 && typeof args[last] === 'function') {
                    const cb = args[last];
                    let called = false;
                    pending++;
                    args[last] = function () {
                        try {
                            return cb.apply(this, arguments);
                        } finally {
                            if (!called) {
                                called = true;
                                pending--;
                                if (pending === 0) {
                                    setImmediate(function () {
                                        if (pending === 0 && ready) finish();
                                    });
                                }
                            }
                        }
                    };
                }
                return original.apply(conn, args);
            };
        });
    }

    conn.on('ready', function () {
        if (finished) return;
        ready = true;
        clearTimeout(readyTimer);
        if (options.operationTimeout > 0) {
            opTimer = setTimeout(function () {
                finish(timeoutError('Timeout: operation did not complete within ' + options.operationTimeout + ' ms', 'ETIMEDOUT_OPERATION'));
            }, options.operationTimeout);
        }
        try {
            opts.onReady(conn, finish);
        } catch (e) {
            finish(e);
            return;
        }
        if (opts.finishWhenIdle) {
            setImmediate(function () {
                if (pending === 0) finish();
            });
        }
    });

    // Must stay attached for the lifetime of the object: an 'error' event
    // without a listener would crash Node-RED.
    conn.on('error', function (err) {
        finish(err || new Error('Unknown FTP error'));
    });

    conn.on('close', function () {
        if (finished) return;
        if (ready && opts.finishWhenIdle) {
            finish();
        } else if (ready) {
            finish(new Error('Connection closed by the server before the operation completed'));
        } else {
            finish(new Error('Connection closed by the server before login completed'));
        }
    });

    if (options.readyTimeout > 0) {
        readyTimer = setTimeout(function () {
            finish(timeoutError('Timeout: no greeting/login from ' + options.host + ':' + options.port +
                ' within ' + options.readyTimeout + ' ms', 'ETIMEDOUT_READY'));
        }, options.readyTimeout);
    }

    try {
        conn.connect(options);
        rawSocket = conn._socket || null;
    } catch (e) {
        // Defer so the caller always gets the handle back before onFinish runs.
        setImmediate(function () { finish(e); });
    }

    return { conn: conn, finish: finish };
}

module.exports = {
    DEFAULT_READY_TIMEOUT: DEFAULT_READY_TIMEOUT,
    DEFAULT_OPERATION_TIMEOUT: DEFAULT_OPERATION_TIMEOUT,
    parseSecureOptions: parseSecureOptions,
    buildConnectOptions: buildConnectOptions,
    startSession: startSession
};
