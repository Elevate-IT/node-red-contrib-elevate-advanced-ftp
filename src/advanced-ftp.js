/**
 * Copyright 2020 Andrea Verardi
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

module.exports = function (RED) {
    'use strict'
    var fs = require('fs')
    var ftpSession = require('./lib/ftp-session');
    var startSession = ftpSession.startSession;
    var buildConnectOptions = ftpSession.buildConnectOptions;

    // Function for configuration
    function AdvancedFtpNode(n) {
        RED.nodes.createNode(this, n);
        var credentials = RED.nodes.getCredentials(n.id) || {};
        var secureOptions = ftpSession.parseSecureOptions(n.secureOptions);
        if (secureOptions.error) this.warn(secureOptions.error);
        this.options = {
            'host': n.host || 'localhost',
            'port': n.port || 21,
            'secure': n.secure || false,
            'secureOptions': secureOptions.value,
            'allowLegacyRenegotiation': n.allowLegacyRenegotiation === true,
            'user': n.user || 'anonymous',
            'password': credentials.password || 'anonymous@',
            'connTimeout': n.connTimeout || 10000,
            'pasvTimeout': n.pasvTimeout || 10000,
            'keepalive': n.keepalive || 10000,
            // Older configs do not have these: defaults are applied in buildConnectOptions()
            'readyTimeout': n.readyTimeout,
            'operationTimeout': n.operationTimeout
        };
    }

    // Register the Node
    RED.nodes.registerType('advanced-ftp-config', AdvancedFtpNode, {
        credentials: {
            password: { type: 'password' }
        }
    });

    // Function for the FTP node
    function AdvancedFtpInNode(n) {
        RED.nodes.createNode(this, n);
        // Set local variables
        this.ftp = n.ftp;
        this.operation = n.operation;
        this.dataType = n.dataType;
        this.command = n.command;
        this.filename = n.filename;
        this.localFilename = n.localFilename;
        this.workingDir = n.workingDir;
        this.oldPath = n.oldPath;
        this.newPath = n.newPath
        this.useCompression = n.useCompression;
        this.recursive = n.recursive;
        this.sendError = n.sendError;
        this.throwError = n.throwError;
        this.showError = n.showError;
        this.ftpConfig = RED.nodes.getNode(this.ftp);
        // Sessions (one connection per message) that are still running
        this.activeSessions = new Set();

        this.status({});

        // If the configuration is present, continue
        if (this.ftpConfig) {
            var node = this;
            // The node has received an input
            node.on('input', function (msg, send, done) {

                node.status({});

                // If this is pre-1.0, 'send' will be undefined, so fallback to node.send
                send = send || function () { node.send.apply(node, arguments) }

                // Allow the user to modify the options
                var options = msg.options || node.ftpConfig.options;

                delete msg.options;

                // The msg.filename takes precedence over the filename set in the node
                var filename = msg.filename || node.filename || '';
                if (typeof filename != 'string') {
                    filename = '';
                }

                // The msg.command takes precedence over the command set in the node
                var command = msg.command || node.command || '';
                if (typeof command != 'string') {
                    command = '';
                }

                // The msg.dataType takes precedence over the dataType set in the node
                var dataType = msg.dataType || node.dataType || '';
                if (typeof dataType != 'string') {
                    dataType = 'binary';
                }

                dataType = dataType.toLocaleLowerCase();

                // The msg.localFilename takes precedence over the localFilename set in the node
                var localFilename = msg.localFilename || node.localFilename || '';
                if (typeof localFilename != 'string') {
                    localFilename = '';
                }

                // The msg.oldPath takes precedence over the oldPath set in the node
                var oldPath = msg.oldPath || msg.path || node.oldPath || '';
                if (typeof oldPath != 'string') {
                    oldPath = '';
                }

                // The msg.newPath takes precedence over the newPath set in the node
                var newPath = msg.newPath || msg.path || node.newPath || '';
                if (typeof newPath != 'string') {
                    newPath = '';
                }

                // The msg.workingDir takes precedence over the workingDir set in the node
                var workingDir = msg.workingDir || node.workingDir || '';
                if (typeof workingDir != 'string') {
                    workingDir = '';
                }

                // The msg.recursive takes precedence over the recursive set in the node
                var recursive = node.recursive;

                if ((msg.recursive !== undefined) && (typeof msg.recursive === 'boolean')) {
                    recursive = msg.recursive;
                }

                // The msg.useCompression takes precedence over the useCompression set in the node
                var useCompression = node.useCompression;

                if ((msg.useCompression !== undefined) && (typeof msg.useCompression === 'boolean')) {
                    useCompression = msg.useCompression;
                }

                // The msg.sendError takes precedence over the sendError set in the node
                var sendError = node.sendError;

                if ((msg.sendError !== undefined) && (typeof msg.sendError === 'boolean')) {
                    sendError = msg.sendError;
                }

                // The msg.showError takes precedence over the showError set in the node
                var showError = node.showError;

                if ((msg.showError !== undefined) && (typeof msg.showError === 'boolean')) {
                    showError = msg.showError;
                }

                // The msg.throwError takes precedence over the throwError set in the node
                var throwError = node.throwError;

                if ((msg.throwError !== undefined) && (typeof msg.throwError === 'boolean')) {
                    throwError = msg.throwError;
                }

                // The msg.operation takes precedence over the operation set in the node
                var operation = msg.operation || node.operation || '';
                if (typeof operation != 'string') {
                    operation = '';
                }

                // The msg.abort takes precedence over the abort set in the node
                var abort = msg.abort;

                // Finish the handling of this message, exactly once
                var completed = false;
                function complete(err) {
                    if (completed) return;
                    completed = true;
                    if (done) {
                        // Node-RED 1.0 compatible
                        if (err && throwError) done(err); else done();
                    } else if (err && throwError) {
                        // Node-RED 0.x compatible
                        node.error(err, msg);
                    }
                }

                if (abort !== undefined && abort === true) {
                    // Every message uses its own connection, so aborting means
                    // tearing down the operations this node still has running.
                    node.activeSessions.forEach(function (session) {
                        var err = new Error('Operation aborted');
                        err.code = 'EABORTED';
                        session.finish(err);
                    });
                    node.status({ fill: 'blue', shape: 'ring', text: 'Aborted' });
                    msg.payload = 'Operation Aborted';
                    msg.abort = abort;
                    send(msg);
                    complete();
                    return;
                }

                operation = operation.toLocaleLowerCase();

                // Validate the parameters required by the operation
                function invalid(errorText) {
                    if (throwError) node.error(errorText);
                    if (showError) node.status({ fill: 'red', shape: 'ring', text: (operation ? operation.toLocaleUpperCase() + ' :Invalid Parameters' : 'Invalid Operation') });
                    if (sendError) {
                        msg.error = errorText;
                        msg.payload = 'Operation Aborted';
                        msg.success = false;
                        send(msg);
                    }
                    complete();
                }

                var invalidParams = 'Invalid Parameters for ' + operation.toLocaleUpperCase();
                switch (operation) {
                    case 'status':
                    case 'list':
                    case 'listsafe':
                    case 'lastmod':
                    case 'size':
                    case 'pwd':
                    case 'system':
                        // Do nothing, does not require additional parameters
                        break;
                    case 'site':
                        if (command === '') return invalid(invalidParams);
                        break;
                    case 'get':
                    case 'append':
                    case 'put':
                        if (filename === '' || localFilename === '') return invalid(invalidParams);
                        break;
                    case 'rename':
                        if (oldPath === '' || newPath === '') return invalid(invalidParams);
                        break;
                    case 'mkdir':
                        if (newPath === '') return invalid(invalidParams);
                        break;
                    case 'rmdir':
                        if (oldPath === '') return invalid(invalidParams);
                        break;
                    case 'delete':
                        if (filename === '') return invalid(invalidParams);
                        break;
                    case 'putrename':
                        if (filename === '' || localFilename === '' || newPath === '') {
                            return invalid(invalidParams + ' : filename: ' + filename + ' localfilename:' + localFilename + ' newPath:' + newPath);
                        }
                        break;
                    default:
                        operation = '';
                        return invalid('Invalid Command');
                }

                var built = buildConnectOptions(options);
                if (built.warning) node.warn(built.warning);
                options = built.options;

                // Display the status of the node
                node.status({ fill: 'yellow', shape: 'ring', text: operation.toLocaleUpperCase() + ' Operation: ' + options.host + ':' + options.port });

                var OP = operation.toLocaleUpperCase();
                var isReady = false;
                var failure = null; // labels for an error reported by an operation callback
                var session;

                // An operation callback failed: close the connection, then report
                function opFailed(err, statusText, payloadText) {
                    failure = { status: statusText, payload: payloadText };
                    session.finish(err || new Error(OP + ' Failed'));
                }

                // The operation is complete: close the connection, then send msg
                function succeed(statusText) {
                    node.status({ fill: 'green', shape: 'ring', text: statusText || (OP + ' Successful') });
                    msg.success = true;
                    session.finish();
                }

                function onFinish(err) {
                    node.activeSessions.delete(session);
                    if (!err) {
                        send(msg);
                        complete();
                        return;
                    }
                    var statusText, payloadText;
                    if (failure) {
                        statusText = failure.status || (OP + ' Failed');
                        payloadText = failure.payload || (OP + ' Failed');
                    } else if (!isReady) {
                        statusText = err.message;
                        payloadText = 'Connection Error';
                    } else {
                        statusText = OP + ' Failed: ' + err.message;
                        payloadText = OP + ' Failed';
                    }
                    if (showError) node.status({ fill: 'red', shape: 'ring', text: statusText });
                    if (sendError) {
                        msg.error = err;
                        msg.payload = payloadText;
                        msg.success = false;
                        send(msg);
                    }
                    complete(err);
                }

                function onReady(conn) {
                    isReady = true;

                    if (dataType !== 'binary') {
                        conn.ascii(function (err) {
                            if (err) opFailed(err);
                        });
                    }

                    msg.operation = operation;
                    msg.dataType = dataType;

                    var listDir = './';
                    if (workingDir != '') {
                        listDir = workingDir.startsWith('./') ? workingDir : './' + workingDir;
                    }

                    switch (operation) {
                        case 'status':
                        case 'pwd':
                        case 'system':
                            conn[operation](function (err, result) {
                                if (err) return opFailed(err);
                                msg.payload = result;
                                succeed();
                            });
                            break;
                        case 'list':
                        case 'listsafe':
                            conn[operation === 'list' ? 'list' : 'listSafe'](listDir, useCompression, function (err, result) {
                                if (err) return opFailed(err);
                                msg.payload = result;
                                succeed();
                            });
                            break;
                        case 'get':
                            conn.get(filename, useCompression, function (err, stream) {
                                if (err) return opFailed(err);
                                node.status({ fill: 'yellow', shape: 'dot', text: 'Pending...' });
                                var writestream;
                                try {
                                    writestream = fs.createWriteStream(localFilename);
                                } catch (e) {
                                    return opFailed(e, 'Something went wrong...');
                                }
                                writestream.on('error', function (e) {
                                    stream.unpipe(writestream);
                                    opFailed(e, 'Something went wrong...');
                                });
                                stream.on('error', function (e) {
                                    writestream.destroy();
                                    opFailed(e);
                                });
                                // 'finish': everything has been flushed to the local file
                                writestream.on('finish', function () {
                                    msg.filename = filename;
                                    msg.localFilename = localFilename;
                                    msg.payload = 'GET operation successful. ' + localFilename;
                                    succeed('GET Successful');
                                });
                                stream.pipe(writestream);
                            });
                            break;
                        case 'put':
                        case 'append':
                            conn[operation](localFilename, filename, useCompression, function (err) {
                                if (err) return opFailed(err);
                                msg.filename = filename;
                                msg.localFilename = localFilename;
                                msg.payload = OP + ' operation successful.';
                                succeed();
                            });
                            break;
                        case 'rename':
                            conn.rename(oldPath, newPath, function (err) {
                                if (err) return opFailed(err);
                                msg.payload = 'RENAME operation successful.';
                                msg.oldPath = oldPath;
                                msg.newPath = newPath;
                                succeed();
                            });
                            break;
                        case 'mkdir':
                            conn.mkdir(newPath, recursive, function (err) {
                                if (err) return opFailed(err);
                                msg.payload = 'MKDIR operation successful.';
                                msg.path = newPath;
                                succeed();
                            });
                            break;
                        case 'rmdir':
                            conn.rmdir(oldPath, recursive, function (err) {
                                if (err) return opFailed(err);
                                msg.payload = 'RMDIR operation successful.';
                                msg.path = oldPath;
                                succeed();
                            });
                            break;
                        case 'delete':
                            conn.delete(filename, function (err, result) {
                                if (err) return opFailed(err);
                                msg.filename = filename;
                                msg.payload = result;
                                succeed();
                            });
                            break;
                        case 'lastmod':
                            conn.lastMod(oldPath, function (err, date) {
                                if (err) return opFailed(err);
                                msg.path = oldPath;
                                msg.payload = Date.parse(date);
                                succeed('LASTMOD Successful');
                            });
                            break;
                        case 'size':
                            conn.size(oldPath, function (err, bytes) {
                                if (err) return opFailed(err);
                                msg.path = oldPath;
                                msg.payload = bytes;
                                succeed();
                            });
                            break;
                        case 'site':
                            conn.site(command, function (err, response, code) {
                                if (err) return opFailed(err);
                                msg.payload = response;
                                msg.responseCode = code;
                                succeed('SITE ' + command + ' Successful');
                            });
                            break;
                        case 'putrename':
                            conn.put(localFilename, filename, useCompression, function (err) {
                                if (err) return opFailed(err, 'PUT Failed', 'PUT operation failed.');
                                // Proceed with rename only after put is successful
                                conn.rename(filename, newPath, function (err) {
                                    if (err) return opFailed(err, 'RENAME Failed', 'RENAME operation failed.');
                                    msg.payload = 'PUTRENAME operation successful.';
                                    msg.filename = filename;
                                    msg.localFilename = localFilename;
                                    msg.newPath = newPath;
                                    succeed();
                                });
                            });
                            break;
                    }
                }

                session = startSession({ options: options, onReady: onReady, onFinish: onFinish });
                if (!completed) node.activeSessions.add(session);
            });

            // Do not leave connections behind on redeploy/shutdown
            node.on('close', function () {
                node.activeSessions.forEach(function (session) {
                    var err = new Error('Node closed');
                    err.code = 'ECLOSED';
                    session.finish(err);
                });
                node.activeSessions.clear();
            });
        } else {
            // Missing Advanced FTP configuration
            this.error('Missing Advanced Ftp configuration');
        }

    }
    RED.nodes.registerType('advanced-ftp', AdvancedFtpInNode);

}
