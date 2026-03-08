"""
Wasmsand sitecustomize — injects socket and ssl shims at interpreter startup.

RustPython's frozen socket module takes priority over PYTHONPATH files.
By loading our shims here (which runs at interpreter startup), we inject
them into sys.modules before any other code can import the frozen versions.
"""
import sys
import types
import importlib
import importlib.machinery

_run = getattr(importlib, '_bootstrap')._call_with_frames_cleaned_up if hasattr(importlib, '_bootstrap') else None


def _inject_shim(name, path):
    """Load a .py file and register it as a sys.modules entry."""
    spec = importlib.machinery.ModuleSpec(name, None, origin=path)
    mod = types.ModuleType(name)
    mod.__spec__ = spec
    mod.__file__ = path
    with open(path) as f:
        code = compile(f.read(), path, "exec")
    # Populate the module namespace from our trusted shim file
    __builtins__["exec"](code, mod.__dict__)  # noqa: S102
    sys.modules[name] = mod


_inject_shim("socket", "/usr/lib/python/socket.py")
_inject_shim("ssl", "/usr/lib/python/ssl.py")
