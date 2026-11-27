# Local FTP test server for test/harness.js (pyftpdlib). Usage: ftp_server.py <root> <certdir> plain|tls
import sys
from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import FTPHandler, TLS_FTPHandler
from pyftpdlib.servers import FTPServer
root, d, mode = sys.argv[1], sys.argv[2], sys.argv[3]
a = DummyAuthorizer(); a.add_user('test', 'test', root, perm='elradfmwMT')
if mode == 'tls':
    class H(TLS_FTPHandler): pass
    H.certfile = d + '/cert.pem'; H.keyfile = d + '/key.pem'; H.tls_control_required = True; H.tls_data_required = True
    H.passive_ports = range(30100, 30200); port = 2122
else:
    class H(FTPHandler): pass
    H.passive_ports = range(30000, 30100); port = 2121
H.authorizer = a
FTPServer(('127.0.0.1', port), H).serve_forever()
