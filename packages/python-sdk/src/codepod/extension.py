from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable


@dataclass
class PythonPackage:
    """Metadata and files for a Python package installed in the sandbox."""
    version: str = "1.0.0"
    summary: str = ""
    files: dict[str, str] = field(default_factory=dict)


@dataclass
class Extension:
    """Host-provided extension registered with the sandbox.

    Args:
        name: Extension name (used as command name and/or package name).
        description: Help text shown by ``<command> --help``.
        command: Callable invoked when the extension is run as a shell command.
            Signature: ``(args, stdin, env, cwd) -> {"stdout": ..., "exitCode": ...}``
        python_package: If provided, installs a Python package in the sandbox.
    """
    name: str
    description: str = ""
    command: Callable | None = None
    python_package: PythonPackage | None = None
