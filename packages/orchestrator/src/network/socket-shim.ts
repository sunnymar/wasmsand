/**
 * Python socket module replacement that routes through a host control fd.
 *
 * This source is written to the VFS at /usr/lib/python/socket.py by
 * Sandbox.create() when networking is enabled. It shadows RustPython's
 * frozen socket module via PYTHONPATH.
 */
export const SOCKET_SHIM_SOURCE = `\
"""
Wasmsand socket shim — routes HTTP through host control fd.

Replaces the standard socket module. Supports connect/send/recv/makefile
for HTTP client use (requests, urllib, http.client).
"""

import os as _os
import json as _json

# Control fd for host communication — must match CONTROL_FD in wasi-host.ts
# and fit in a signed 32-bit int (RustPython's os.write uses i32 for fd).
CONTROL_FD = 1023

# Constants expected by http.client and urllib3
AF_INET = 2
AF_INET6 = 10
SOCK_STREAM = 1
SOCK_DGRAM = 2
IPPROTO_TCP = 6
SOL_SOCKET = 1
SO_KEEPALIVE = 9
TCP_NODELAY = 1
SHUT_RDWR = 2
_GLOBAL_DEFAULT_TIMEOUT = object()
timeout = OSError
error = OSError
herror = OSError
gaierror = OSError


def create_connection(address, timeout=_GLOBAL_DEFAULT_TIMEOUT, source_address=None):
    host, port = address
    sock = socket(AF_INET, SOCK_STREAM)
    if timeout is not _GLOBAL_DEFAULT_TIMEOUT and timeout is not None:
        sock.settimeout(timeout)
    sock.connect((host, port))
    return sock


def getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    if isinstance(port, str):
        port = int(port)
    return [(AF_INET, SOCK_STREAM, IPPROTO_TCP, '', (host, port or 80))]


def getfqdn(name=''):
    return name or 'localhost'


def gethostname():
    return 'localhost'


def gethostbyname(hostname):
    return '127.0.0.1'


def _control(cmd):
    """Send a JSON command to the host control fd, read JSON response."""
    payload = _json.dumps(cmd).encode('utf-8') + b"\\n"
    _os.write(CONTROL_FD, payload)
    data = _os.read(CONTROL_FD, 16 * 1024 * 1024)
    return _json.loads(data)


class socket:
    """Minimal socket implementing the subset needed for HTTP clients."""

    def __init__(self, family=AF_INET, type=SOCK_STREAM, proto=0, fileno=None):
        self._family = family
        self._type = type
        self._host = None
        self._port = None
        self._conn_id = None
        self._timeout = None
        self._sendbuf = b""
        self._recvbuf = b""
        self._closed = False

    def connect(self, address):
        host, port = address
        if isinstance(port, str):
            port = int(port)
        self._host = host
        self._port = port
        resp = _control({"cmd": "connect", "host": host, "port": port})
        self._conn_id = resp["id"]

    def connect_ex(self, address):
        try:
            self.connect(address)
            return 0
        except Exception:
            return 1

    def sendall(self, data):
        if isinstance(data, memoryview):
            data = bytes(data)
        self._sendbuf += data

    def send(self, data):
        if isinstance(data, memoryview):
            data = bytes(data)
        self._sendbuf += data
        return len(data)

    def recv(self, bufsize):
        if not self._recvbuf and self._should_flush():
            self._flush_request()
        chunk = self._recvbuf[:bufsize]
        self._recvbuf = self._recvbuf[bufsize:]
        return chunk

    def recv_into(self, buffer, nbytes=0):
        data = self.recv(nbytes or len(buffer))
        buffer[:len(data)] = data
        return len(data)

    def makefile(self, mode="r", buffering=-1, **kwargs):
        return _SocketFile(self, mode)

    def settimeout(self, timeout):
        self._timeout = timeout

    def gettimeout(self):
        return self._timeout

    def setblocking(self, flag):
        self._timeout = None if flag else 0.0

    def setsockopt(self, *args):
        pass

    def getsockopt(self, *args):
        return 0

    def getpeername(self):
        return (self._host, self._port)

    def fileno(self):
        return -1

    def close(self):
        if self._conn_id and not self._closed:
            try:
                _control({"cmd": "close", "id": self._conn_id})
            except Exception:
                pass
            self._closed = True

    def shutdown(self, how):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def _should_flush(self):
        """Check if send buffer contains a complete HTTP request."""
        idx = self._sendbuf.find(b"\\r\\n\\r\\n")
        if idx < 0:
            return False
        header_block = self._sendbuf[:idx].decode("utf-8", errors="replace")
        for line in header_block.split("\\r\\n"):
            if line.lower().startswith("content-length:"):
                expected = int(line.split(":", 1)[1].strip())
                body_start = idx + 4
                return len(self._sendbuf) - body_start >= expected
        return True

    def _flush_request(self):
        """Parse buffered HTTP request, send via control fd, buffer response."""
        raw = self._sendbuf.decode("utf-8", errors="replace")
        head, _, body = raw.partition("\\r\\n\\r\\n")
        first_line, _, header_block = head.partition("\\r\\n")
        parts = first_line.split(" ", 2)
        method = parts[0] if parts else "GET"
        path = parts[1] if len(parts) > 1 else "/"
        headers = {}
        for line in header_block.split("\\r\\n"):
            if ": " in line:
                k, v = line.split(": ", 1)
                headers[k] = v
        resp = _control({
            "cmd": "request",
            "id": self._conn_id,
            "method": method,
            "path": path,
            "headers": headers,
            "body": body,
        })
        if not resp.get("ok"):
            raise OSError(resp.get("error", "request failed"))
        status = resp.get("status", 200)
        resp_headers = resp.get("headers", {})
        resp_body = resp.get("body", "")
        status_line = "HTTP/1.1 {} OK\\r\\n".format(status)
        header_lines = "".join("{}: {}\\r\\n".format(k, v) for k, v in resp_headers.items())
        body_bytes = resp_body.encode("utf-8") if isinstance(resp_body, str) else resp_body
        cl = "Content-Length: {}\\r\\n".format(len(body_bytes))
        self._recvbuf = (status_line + header_lines + cl + "\\r\\n").encode("utf-8") + body_bytes
        self._sendbuf = b""


class _SocketFile:
    """File-like wrapper returned by socket.makefile() — used by http.client."""

    def __init__(self, sock, mode):
        self._sock = sock
        self._mode = mode
        self.closed = False

    def read(self, n=-1):
        if not self._sock._recvbuf and self._sock._should_flush():
            self._sock._flush_request()
        if n is None or n < 0:
            data = self._sock._recvbuf
            self._sock._recvbuf = b""
            return data
        return self._sock.recv(n)

    def read1(self, n=-1):
        return self.read(n)

    def readinto(self, b):
        data = self.read(len(b))
        b[:len(data)] = data
        return len(data)

    def readline(self, limit=-1):
        if not self._sock._recvbuf and self._sock._should_flush():
            self._sock._flush_request()
        buf = self._sock._recvbuf
        idx = buf.find(b"\\n")
        if idx >= 0:
            if limit > 0 and idx >= limit:
                line = buf[:limit]
                self._sock._recvbuf = buf[limit:]
            else:
                line = buf[:idx + 1]
                self._sock._recvbuf = buf[idx + 1:]
            return line
        if limit > 0:
            line = buf[:limit]
            self._sock._recvbuf = buf[limit:]
            return line
        self._sock._recvbuf = b""
        return buf

    def readlines(self, hint=-1):
        lines = []
        while True:
            line = self.readline()
            if not line:
                break
            lines.append(line)
        return lines

    def write(self, data):
        if isinstance(data, str):
            data = data.encode("utf-8")
        self._sock.sendall(data)
        return len(data)

    def flush(self):
        pass

    def close(self):
        self.closed = True

    def readable(self):
        return "r" in self._mode or "b" in self._mode

    def writable(self):
        return "w" in self._mode

    def seekable(self):
        return False

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def __iter__(self):
        return self

    def __next__(self):
        line = self.readline()
        if not line:
            raise StopIteration
        return line
`;

/**
 * sitecustomize.py source that pre-loads our socket shim into sys.modules.
 *
 * RustPython's frozen `socket` module takes priority over PYTHONPATH files.
 * By loading our shim in sitecustomize.py (which runs at interpreter startup),
 * we inject it into sys.modules["socket"] before any other code can import
 * the frozen version.
 */
export const SITE_CUSTOMIZE_SOURCE = `\
import sys
import types
import importlib.machinery
_spec = importlib.machinery.ModuleSpec("socket", None, origin="/usr/lib/python/socket.py")
_mod = types.ModuleType("socket")
_mod.__spec__ = _spec
_mod.__file__ = "/usr/lib/python/socket.py"
with open("/usr/lib/python/socket.py") as _f:
    _code = _f.read()
exec(compile(_code, "/usr/lib/python/socket.py", "exec"), _mod.__dict__)
sys.modules["socket"] = _mod
del _spec, _mod, _f, _code
`;
