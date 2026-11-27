// Integration tests for the advanced-ftp nodes, using a minimal fake Node-RED runtime.
// Run through test/run.sh, which starts the FTP servers this needs:
//   plain FTP on 127.0.0.1:2121 and explicit FTPS on 127.0.0.1:2122, user test/test,
//   serving <workdir>/root. Usage: node test/harness.js <workdir>
'use strict';
const path = require('path');
const fs = require('fs');
const net = require('net');
const assert = require('assert');
const REPO = path.resolve(__dirname, '..');
const DIR = process.argv[2];
if (!DIR) { console.error('usage: node test/harness.js <workdir>'); process.exit(2); }
fs.mkdirSync(path.join(DIR, 'local'), { recursive: true });

const types = {};
const nodes = {};
const RED = {
    nodes: {
        createNode(node, n) {
            node.id = n.id;
            node._handlers = {};
            node.statuses = [];
            node.warnings = [];
            node.errors = [];
            node.on = (ev, fn) => { (node._handlers[ev] = node._handlers[ev] || []).push(fn); };
            node.status = (s) => node.statuses.push(s);
            node.warn = (w) => node.warnings.push(w);
            node.error = (e, m) => node.errors.push(e);
            node.send = () => { throw new Error('node.send used'); };
            nodes[n.id] = node;
        },
        getNode: (id) => nodes[id],
        getCredentials: (id) => ({ password: 'test' }),
        registerType(name, ctor) { types[name] = ctor; }
    }
};
require(path.join(REPO, 'src/advanced-ftp.js'))(RED);
require(path.join(REPO, 'src/advanced-ftp-logger.js'))(RED);

let seq = 0;
function config(extra) {
    const id = 'cfg' + (++seq);
    new types['advanced-ftp-config'](Object.assign({ id, host: '127.0.0.1', port: 2121, user: 'test' }, extra));
    return id;
}
function ftpNode(cfg, extra) {
    const id = 'n' + (++seq);
    new types['advanced-ftp'](Object.assign({ id, ftp: cfg, operation: 'list', dataType: 'binary', sendError: true, throwError: true, showError: true }, extra));
    return nodes[id];
}
// Send one message, resolve with { sent: [...], doneArgs: [...], ms } once done() is called.
function run(node, msg, waitAfterDone = 300) {
    return new Promise((resolve) => {
        const sent = [];
        const doneCalls = [];
        const t0 = Date.now();
        let resolved = false;
        const done = (err) => {
            doneCalls.push(err);
            if (!resolved) {
                resolved = true;
                setTimeout(() => resolve({ sent, doneCalls, ms: Date.now() - t0 }), waitAfterDone);
            }
        };
        node._handlers.input.forEach((h) => h(msg, (m) => sent.push(JSON.parse(JSON.stringify(m, (k, v) => v instanceof Error ? { message: v.message, code: v.code } : v))), done));
    });
}

const results = [];
async function test(name, fn) {
    try {
        await fn();
        results.push(['PASS', name]);
    } catch (e) {
        results.push(['FAIL', name, e.message]);
    }
}

(async () => {
    // Silent server: accepts TCP, never sends the 220 greeting.
    const silentSockets = [];
    const silent = net.createServer((s) => { silentSockets.push(s); s.on('error', () => {}); }).listen(2123, '127.0.0.1');
    // Greets, then closes the connection.
    const closer = net.createServer((s) => { s.write('220 hi\r\n'); setTimeout(() => s.destroy(), 50); }).listen(2124, '127.0.0.1');
    // Logs in fine, then never answers anything after login (hangs mid-operation).
    const stall = net.createServer((s) => {
        s.write('220 hi\r\n');
        s.on('data', (d) => {
            const cmd = d.toString().trim().split(' ')[0];
            if (cmd === 'USER') s.write('331 pw\r\n');
            else if (cmd === 'PASS') s.write('230 ok\r\n');
            else if (cmd === 'FEAT') s.write('211 none\r\n');
            else if (cmd === 'TYPE') s.write('200 ok\r\n');
            // anything else: silence
        });
        s.on('error', () => {});
    }).listen(2125, '127.0.0.1');

    const local = path.join(DIR, 'local');
    fs.writeFileSync(path.join(local, 'up.txt'), 'hello world\n'.repeat(1000));

    await test('greeting hang -> ETIMEDOUT_READY, done(err) once, socket destroyed', async () => {
        const node = ftpNode(config({ port: 2123, readyTimeout: 1000 }));
        const r = await run(node, { operation: 'list' });
        assert.strictEqual(r.doneCalls.length, 1);
        assert.strictEqual(r.doneCalls[0] && r.doneCalls[0].code, 'ETIMEDOUT_READY');
        assert(r.ms >= 1000 && r.ms < 2000, 'took ' + r.ms);
        assert.strictEqual(r.sent.length, 1);
        assert.strictEqual(r.sent[0].payload, 'Connection Error');
        assert.strictEqual(r.sent[0].success, false);
        await new Promise((res) => setTimeout(res, 200));
        assert(silentSockets.every((s) => s.destroyed || s.readyState === 'closed'), 'server side socket still open');
        assert.strictEqual(node.activeSessions.size, 0);
    });

    await test('old config without readyTimeout uses 10 s default', async () => {
        const node = ftpNode(config({ port: 2123 }));
        const r = await run(node, { operation: 'list' }, 0);
        assert.strictEqual(r.doneCalls[0].code, 'ETIMEDOUT_READY');
        assert(r.ms >= 10000 && r.ms < 11000, 'took ' + r.ms);
    });

    await test('server closes before login -> error', async () => {
        const node = ftpNode(config({ port: 2124 }));
        const r = await run(node, { operation: 'list' });
        assert.strictEqual(r.doneCalls.length, 1);
        assert(r.doneCalls[0] instanceof Error);
        assert(r.ms < 2000);
    });

    await test('stall after login -> ETIMEDOUT_OPERATION', async () => {
        const node = ftpNode(config({ port: 2125, operationTimeout: 800 }));
        const r = await run(node, { operation: 'pwd' });
        assert.strictEqual(r.doneCalls.length, 1);
        assert.strictEqual(r.doneCalls[0].code, 'ETIMEDOUT_OPERATION');
        assert.strictEqual(r.sent[0].payload, 'PWD Failed');
    });

    await test('connection refused -> error', async () => {
        const node = ftpNode(config({ port: 2199 }));
        const r = await run(node, { operation: 'list' });
        assert.strictEqual(r.doneCalls.length, 1);
        assert.strictEqual(r.doneCalls[0].code, 'ECONNREFUSED');
    });

    await test('throwError=false -> done() without error', async () => {
        const node = ftpNode(config({ port: 2199 }), { throwError: false });
        const r = await run(node, { operation: 'list' });
        assert.deepStrictEqual(r.doneCalls, [undefined]);
    });

    for (const [label, port, secure] of [['plain', 2121, false], ['explicit FTPS', 2122, true]]) {
        const cfg = config({ port, secure, secureOptions: secure ? '{"rejectUnauthorized": false}' : '' });
        const node = ftpNode(cfg);

        await test(label + ': mkdir', async () => {
            const r = await run(node, { operation: 'mkdir', newPath: 'dir_' + port });
            assert.deepStrictEqual(r.doneCalls, [undefined]);
            assert.strictEqual(r.sent[0].payload, 'MKDIR operation successful.');
            assert.strictEqual(r.sent[0].success, true);
        });
        await test(label + ': put', async () => {
            const r = await run(node, { operation: 'put', localFilename: path.join(local, 'up.txt'), filename: 'dir_' + port + '/a.txt' });
            assert.deepStrictEqual(r.doneCalls, [undefined]);
            assert.strictEqual(r.sent[0].payload, 'PUT operation successful.');
        });
        await test(label + ': putrename', async () => {
            const r = await run(node, { operation: 'putrename', localFilename: path.join(local, 'up.txt'), filename: 'dir_' + port + '/tmp.txt', newPath: 'dir_' + port + '/b.txt' });
            assert.deepStrictEqual(r.doneCalls, [undefined]);
            assert.strictEqual(r.sent[0].payload, 'PUTRENAME operation successful.');
        });
        await test(label + ': list', async () => {
            const r = await run(node, { operation: 'list', workingDir: 'dir_' + port });
            assert.deepStrictEqual(r.doneCalls, [undefined]);
            assert.deepStrictEqual(r.sent[0].payload.map((e) => e.name).sort(), ['a.txt', 'b.txt']);
        });
        await test(label + ': get (file complete when msg is sent)', async () => {
            const dest = path.join(local, 'down_' + port + '.txt');
            const node2 = ftpNode(cfg);
            let sizeAtSend = -1;
            const r = await new Promise((resolve) => {
                const sent = [];
                node2._handlers.input[0]({ operation: 'get', filename: 'dir_' + port + '/a.txt', localFilename: dest }, (m) => { sizeAtSend = fs.existsSync(dest) ? fs.statSync(dest).size : -2; sent.push(m); }, (err) => setTimeout(() => resolve({ sent, err }), 100));
            });
            assert.strictEqual(r.err, undefined);
            assert.strictEqual(sizeAtSend, 12000);
            assert.strictEqual(r.sent[0].payload, 'GET operation successful. ' + dest);
        });
        await test(label + ': size / lastmod / pwd / status / system / site', async () => {
            let r = await run(node, { operation: 'size', path: 'dir_' + port + '/a.txt' });
            assert.strictEqual(r.sent[0].payload, 12000);
            r = await run(node, { operation: 'lastmod', path: 'dir_' + port + '/a.txt' });
            assert(r.sent[0].payload > 0);
            r = await run(node, { operation: 'pwd' });
            assert.strictEqual(r.sent[0].payload, '/');
            r = await run(node, { operation: 'system' });
            assert.deepStrictEqual(r.doneCalls, [undefined]);
            r = await run(node, { operation: 'status' });
            assert.deepStrictEqual(r.doneCalls, [undefined]);
            r = await run(node, { operation: 'site', command: 'HELP' });
            assert.deepStrictEqual(r.doneCalls, [undefined]);
            assert.strictEqual(node.activeSessions.size, 0);
        });
        await test(label + ': get missing file -> GET Failed', async () => {
            const r = await run(node, { operation: 'get', filename: 'nope.txt', localFilename: path.join(local, 'x') });
            assert.strictEqual(r.doneCalls.length, 1);
            assert(r.doneCalls[0] instanceof Error);
            assert.strictEqual(r.sent[0].payload, 'GET Failed');
        });
        await test(label + ': rename failure in putrename -> RENAME operation failed.', async () => {
            const r = await run(node, { operation: 'putrename', localFilename: path.join(local, 'up.txt'), filename: 'dir_' + port + '/c.txt', newPath: 'nodir/x/y.txt' });
            assert.strictEqual(r.sent[0].payload, 'RENAME operation failed.');
        });
        await test(label + ': 10 concurrent puts on one node', async () => {
            const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => run(node, { operation: 'put', localFilename: path.join(local, 'up.txt'), filename: 'dir_' + port + '/c' + i + '.txt' })));
            rs.forEach((r, i) => {
                assert.deepStrictEqual(r.doneCalls, [undefined]);
                assert.strictEqual(r.sent.length, 1);
                assert.strictEqual(r.sent[0].filename, 'dir_' + port + '/c' + i + '.txt');
            });
        });
        await test(label + ': delete + rmdir', async () => {
            for (const f of ['a.txt', 'b.txt', 'c.txt'].concat(Array.from({ length: 10 }, (_, i) => 'c' + i + '.txt'))) {
                await run(node, { operation: 'delete', filename: 'dir_' + port + '/' + f }, 0);
            }
            const r = await run(node, { operation: 'rmdir', path: 'dir_' + port });
            assert.deepStrictEqual(r.doneCalls, [undefined]);
        });
    }

    await test('invalid secureOptions text -> warning, ignored, still connects', async () => {
        const cfg = config({ port: 2122, secure: true, secureOptions: 'rejectUnauthorized=false' });
        assert.strictEqual(nodes[cfg].warnings.length, 1);
        const r = await run(ftpNode(cfg), { operation: 'pwd' });
        // self-signed cert is rejected because the option was not applied
        assert(r.doneCalls[0] instanceof Error && /self.signed/i.test(r.doneCalls[0].message), String(r.doneCalls[0] && r.doneCalls[0].message));
    });

    await test('msg.options object with secureOptions object still works', async () => {
        const node = ftpNode(config({ port: 2121 }));
        const r = await run(node, { operation: 'pwd', options: { host: '127.0.0.1', port: 2122, user: 'test', password: 'test', secure: true, secureOptions: { rejectUnauthorized: false } } });
        assert.deepStrictEqual(r.doneCalls, [undefined]);
    });

    await test('legacy renegotiation flag sets SSL_OP_LEGACY_SERVER_CONNECT + servername', async () => {
        const { buildConnectOptions } = require(path.join(REPO, 'src/lib/ftp-session.js'));
        const c = require('crypto').constants;
        const o = buildConnectOptions({ host: 'ftp.example.com', secure: true, allowLegacyRenegotiation: true, secureOptions: { secureOptions: c.SSL_OP_NO_TICKET } }).options;
        assert.strictEqual(o.secureOptions.secureOptions, c.SSL_OP_NO_TICKET + c.SSL_OP_LEGACY_SERVER_CONNECT);
        assert.strictEqual(o.secureOptions.servername, 'ftp.example.com');
        const ip = buildConnectOptions({ host: '1.2.3.4', secure: true }).options;
        assert.strictEqual(ip.secureOptions.servername, undefined);
        assert.strictEqual(ip.secureOptions.secureOptions, undefined);
        assert.strictEqual(ip.readyTimeout, 10000);
        assert.strictEqual(ip.operationTimeout, 300000);
    });

    await test('invalid operation -> done() called, no connection', async () => {
        const node = ftpNode(config({}));
        const r = await run(node, { operation: 'bogus' });
        assert.deepStrictEqual(r.doneCalls, [undefined]);
        assert.strictEqual(r.sent[0].error, 'Invalid Command');
    });

    await test('abort tears down in-flight operations', async () => {
        const node = ftpNode(config({ port: 2123, readyTimeout: 0 }));
        const p = run(node, { operation: 'list' });
        await new Promise((res) => setTimeout(res, 200));
        assert.strictEqual(node.activeSessions.size, 1);
        const a = await run(node, { abort: true });
        assert.strictEqual(a.sent[0].payload, 'Operation Aborted');
        const r = await p;
        assert.strictEqual(r.doneCalls[0].code, 'EABORTED');
        assert.strictEqual(node.activeSessions.size, 0);
    });

    await test('node close destroys in-flight sessions', async () => {
        const node = ftpNode(config({ port: 2123, readyTimeout: 0 }));
        const p = run(node, { operation: 'list' });
        await new Promise((res) => setTimeout(res, 200));
        node._handlers.close.forEach((h) => h());
        const r = await p;
        assert.strictEqual(r.doneCalls[0].code, 'ECLOSED');
    });

    // Logger node
    const logCfg = config({ port: 2121 });
    const logDir = path.join(local, 'log');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'data.txt'), 'line\n'.repeat(50));
    function logger(extra) {
        const id = 'n' + (++seq);
        new types['advanced-ftp-logger'](Object.assign({ id, ftp: logCfg, localDirectory: logDir, ftpDirectory: 'logs', ftpFilename: 'log#', maxFiles: 3, maxFileSize: 1, fileSizeDim: 'kb', throwError: true, showError: true }, extra));
        return nodes[id];
    }
    await test('logger: 6 sequential runs complete (done once each) and rotate', async () => {
        const node = logger();
        for (let i = 0; i < 6; i++) {
            const r = await run(node, {});
            assert.strictEqual(r.doneCalls.length, 1, 'run ' + i + ' done calls ' + r.doneCalls.length);
            assert.strictEqual(r.doneCalls[0], undefined, 'run ' + i + ' err ' + (r.doneCalls[0] && r.doneCalls[0].message));
            assert(r.ms < 3000, 'run ' + i + ' took ' + r.ms);
        }
        assert.strictEqual(node.activeSessions.size, 0);
        const files = fs.readdirSync(path.join(DIR, 'root', 'logs')).sort();
        assert(files.length >= 2 && files.length <= 3, files.join(','));
    });
    await test('logger: greeting hang -> timeout error', async () => {
        const cfg = config({ port: 2123, readyTimeout: 500 });
        const id = 'n' + (++seq);
        new types['advanced-ftp-logger']({ id, ftp: cfg, localDirectory: logDir, ftpDirectory: 'logs', ftpFilename: 'log#', maxFiles: 3, maxFileSize: 1, fileSizeDim: 'kb', throwError: true, showError: true });
        const r = await run(nodes[id], {});
        assert.strictEqual(r.doneCalls.length, 1);
        assert.strictEqual(r.doneCalls[0].code, 'ETIMEDOUT_READY');
    });

    silent.close(); closer.close(); stall.close();
    silentSockets.forEach((s) => s.destroy());
    for (const r of results) console.log(r.join('  '));
    const failed = results.filter((r) => r[0] === 'FAIL').length;
    console.log(failed ? failed + ' FAILED' : 'ALL ' + results.length + ' PASSED');
    setTimeout(() => process.exit(failed ? 1 : 0), 200);
})();
