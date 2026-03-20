from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Awaitable, Callable


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
        description: One-liner shown by ``extensions list``.
        command: Callable invoked when the extension is run as a shell command.
            Signature: ``(args, stdin, env, cwd) -> {"stdout": ..., "exitCode": ...}``
        async_command: Async callable with the same signature as *command*.
            Takes priority over *command* if both are set.
        usage: Usage string shown by ``extensions info``, e.g. ``"search <query> [--k N]"``.
        examples: Concrete shell invocations shown by ``extensions info``.
        category: Free-form grouping label, e.g. ``"search"``, ``"files"``.
        python_package: If provided, installs a Python package in the sandbox.
    """
    name: str
    description: str = ""
    command: Callable | None = None
    async_command: Callable[..., Awaitable[dict]] | None = None
    usage: str = ""
    examples: list[str] = field(default_factory=list)
    category: str = ""
    python_package: PythonPackage | None = None


# ── Built-in discovery command ────────────────────────────────────────────────

_HELP_TEXT = """\
Usage: extensions <subcommand> [options]

Subcommands:
  list [--category <cat>] [--json]   List all registered extensions
  info <name>                        Show details for a specific extension
"""


def _handle_list(extensions: list[Extension], args: list[str]) -> dict:
    filter_cat: str | None = None
    json_mode = False
    i = 0
    while i < len(args):
        if args[i] == "--category" and i + 1 < len(args):
            filter_cat = args[i + 1]
            i += 2
        elif args[i] == "--json":
            json_mode = True
            i += 1
        else:
            i += 1

    filtered = [e for e in extensions if filter_cat is None or e.category == filter_cat]

    if json_mode:
        data = [{"name": e.name, "category": e.category, "description": e.description}
                for e in filtered]
        return {"stdout": json.dumps(data) + "\n", "exitCode": 0}

    if not filtered:
        return {"stdout": "(no extensions registered)\n", "exitCode": 0}

    name_w = max(4, *(len(e.name) for e in filtered))
    cat_w = max(8, *(len(e.category) for e in filtered))
    header = f"{'NAME':<{name_w}}  {'CATEGORY':<{cat_w}}  DESCRIPTION"
    sep = "\u2500" * len(header)
    rows = [f"{e.name:<{name_w}}  {e.category:<{cat_w}}  {e.description}" for e in filtered]
    return {"stdout": "\n".join([header, sep, *rows]) + "\n", "exitCode": 0}


def _handle_info(extensions: list[Extension], args: list[str]) -> dict:
    if not args:
        return {"stdout": "", "stderr": "extensions info: missing extension name\n", "exitCode": 1}
    name = args[0]
    ext = next((e for e in extensions if e.name == name), None)
    if ext is None:
        return {"stdout": "", "stderr": f"extensions: unknown extension: {name}\n", "exitCode": 1}

    lines = [
        f"Name:        {ext.name}",
        f"Category:    {ext.category}",
        f"Description: {ext.description}",
    ]
    if ext.usage:
        lines.append(f"Usage:       {ext.usage}")
    if ext.examples:
        lines.append("Examples:")
        for ex in ext.examples:
            lines.append(f"  {ex}")
    return {"stdout": "\n".join(lines) + "\n", "exitCode": 0}


def _extensions_handler(extensions: list[Extension], args: list[str]) -> dict:
    """Built-in handler for the 'extensions' discovery command."""
    if not args or args[0] in ("--help", "-h"):
        return {"stdout": _HELP_TEXT, "exitCode": 0}

    subcmd = args[0]
    rest = args[1:]

    if subcmd == "list":
        return _handle_list(extensions, rest)
    if subcmd == "info":
        return _handle_info(extensions, rest)
    return {
        "stdout": "",
        "stderr": f"extensions: unknown subcommand: {subcmd}\n{_HELP_TEXT}",
        "exitCode": 1,
    }


def _make_extensions_command(user_extensions: list[Extension]) -> Extension:
    """Create the built-in extensions discovery command for a given extension list."""
    def handler(args, stdin, env, cwd):  # noqa: ARG001
        return _extensions_handler(user_extensions, args)

    return Extension(
        name="extensions",
        command=handler,
    )
