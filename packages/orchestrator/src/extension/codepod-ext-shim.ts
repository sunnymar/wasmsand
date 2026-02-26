/**
 * Python source for /usr/lib/python/codepod_ext.py — bridge to host
 * extensions via extension fd 1022 (FD_MAX-2).
 */
export const CODEPOD_EXT_SOURCE = `\
"""codepod_ext -- bridge to host extensions via extension fd 1022 (FD_MAX-2)."""
import os as _os
import json as _json

_EXTENSION_FD = 1022

def call(extension_name, method, **kwargs):
    """Call a host extension method. Returns the parsed JSON result."""
    cmd = {"cmd": "extensionInvoke", "extension": extension_name, "method": method, "kwargs": kwargs}
    payload = _json.dumps(cmd).encode("utf-8") + b"\\n"
    _os.write(_EXTENSION_FD, payload)
    data = _os.read(_EXTENSION_FD, 16 * 1024 * 1024)
    resp = _json.loads(data)
    if not resp.get("ok"):
        raise RuntimeError(resp.get("error", "extension call failed"))
    return resp.get("result")
`;
