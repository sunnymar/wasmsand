"""Extension system integration tests for the Python SDK.

Tests the full round-trip: Python host registers extension -> sandbox runs it
-> handler called -> result returned.
"""
import json
import pytest
from codepod import Sandbox, Extension, PythonPackage


class TestExtensionCommands:
    def test_extension_command_runs(self):
        def my_handler(args, stdin, env, cwd):
            return {"stdout": "hello from python host\n", "exitCode": 0}

        ext = Extension(name="pyext", description="Test ext", command=my_handler)
        with Sandbox(extensions=[ext]) as sbx:
            result = sbx.commands.run("pyext")
            assert result.exit_code == 0
            assert result.stdout.strip() == "hello from python host"

    def test_extension_receives_args(self):
        def echo_args(args, stdin, env, cwd):
            return {"stdout": " ".join(args) + "\n", "exitCode": 0}

        ext = Extension(name="echoext", command=echo_args)
        with Sandbox(extensions=[ext]) as sbx:
            result = sbx.commands.run("echoext foo bar baz")
            assert result.exit_code == 0
            assert result.stdout.strip() == "foo bar baz"

    def test_extension_receives_piped_stdin(self):
        def upper(args, stdin, env, cwd):
            return {"stdout": stdin.upper(), "exitCode": 0}

        ext = Extension(name="upper", command=upper)
        with Sandbox(extensions=[ext]) as sbx:
            result = sbx.commands.run("echo hello | upper")
            assert result.exit_code == 0
            assert result.stdout.strip() == "HELLO"

    def test_extension_help(self):
        ext = Extension(
            name="helper",
            description="A helpful extension\nUsage: helper [opts]",
            command=lambda **kw: {"stdout": "", "exitCode": 0},
        )
        with Sandbox(extensions=[ext]) as sbx:
            result = sbx.commands.run("helper --help")
            assert result.exit_code == 0
            assert "A helpful extension" in result.stdout

    def test_which_finds_extension(self):
        ext = Extension(
            name="myext",
            command=lambda **kw: {"stdout": "", "exitCode": 0},
        )
        with Sandbox(extensions=[ext]) as sbx:
            result = sbx.commands.run("which myext")
            assert result.exit_code == 0
            assert "/usr/bin/myext" in result.stdout


class TestExtensionPythonPackages:
    def test_pip_list_shows_package(self):
        ext = Extension(
            name="analyzer",
            python_package=PythonPackage(
                version="2.0.0",
                summary="Code analyzer",
                files={"__init__.py": ""},
            ),
        )
        with Sandbox(extensions=[ext]) as sbx:
            result = sbx.commands.run("pip list")
            assert result.exit_code == 0
            assert "analyzer" in result.stdout
            assert "2.0.0" in result.stdout

    def test_pip_show_displays_metadata(self):
        ext = Extension(
            name="testlib",
            python_package=PythonPackage(
                version="1.5.0",
                summary="A test library",
                files={"__init__.py": "", "core.py": "x = 1"},
            ),
        )
        with Sandbox(extensions=[ext]) as sbx:
            result = sbx.commands.run("pip show testlib")
            assert result.exit_code == 0
            assert "Name: testlib" in result.stdout
            assert "Version: 1.5.0" in result.stdout
            assert "Summary: A test library" in result.stdout


class TestExtensionsDiscovery:
    """Tests for the built-in 'extensions' discovery command."""

    def _make_extensions(self):
        return [
            Extension(
                name="search",
                description="Search the index",
                category="search",
                usage="search <query> [--k N]",
                examples=["search 'cost analysis'", "search 'foo' --k 20"],
                command=lambda **kw: {"stdout": "", "exitCode": 0},
            ),
            Extension(
                name="fetch",
                description="Fetch a document",
                category="search",
                command=lambda **kw: {"stdout": "", "exitCode": 0},
            ),
            Extension(
                name="upload",
                description="Upload a file",
                category="files",
                command=lambda **kw: {"stdout": "", "exitCode": 0},
            ),
        ]

    def test_extensions_list(self):
        with Sandbox(extensions=self._make_extensions()) as sbx:
            result = sbx.commands.run("extensions list")
            assert result.exit_code == 0
            assert "search" in result.stdout
            assert "fetch" in result.stdout
            assert "upload" in result.stdout
            # built-in 'extensions' itself should not appear in the listing
            lines = result.stdout.splitlines()
            data_lines = [l for l in lines if l.strip() and not l.startswith("─") and not l.startswith("NAME")]
            names = [l.split()[0] for l in data_lines]
            assert "extensions" not in names

    def test_extensions_list_filter_category(self):
        with Sandbox(extensions=self._make_extensions()) as sbx:
            result = sbx.commands.run("extensions list --category search")
            assert result.exit_code == 0
            assert "search" in result.stdout
            assert "fetch" in result.stdout
            assert "upload" not in result.stdout

    def test_extensions_list_json(self):
        with Sandbox(extensions=self._make_extensions()) as sbx:
            result = sbx.commands.run("extensions list --json")
            assert result.exit_code == 0
            data = json.loads(result.stdout)
            names = [e["name"] for e in data]
            assert "search" in names
            assert "extensions" not in names

    def test_extensions_info(self):
        with Sandbox(extensions=self._make_extensions()) as sbx:
            result = sbx.commands.run("extensions info search")
            assert result.exit_code == 0
            assert "search <query>" in result.stdout
            assert "cost analysis" in result.stdout

    def test_extensions_info_unknown(self):
        with Sandbox(extensions=self._make_extensions()) as sbx:
            result = sbx.commands.run("extensions info nope")
            assert result.exit_code == 1
            assert "unknown extension" in result.stderr

    def test_extensions_help(self):
        with Sandbox(extensions=self._make_extensions()) as sbx:
            result = sbx.commands.run("extensions --help")
            assert result.exit_code == 0
            assert "Subcommands" in result.stdout

    def test_extensions_unknown_subcommand(self):
        with Sandbox(extensions=self._make_extensions()) as sbx:
            result = sbx.commands.run("extensions bogus")
            assert result.exit_code == 1
            assert "unknown subcommand" in result.stderr

    def test_which_finds_extensions(self):
        with Sandbox(extensions=self._make_extensions()) as sbx:
            result = sbx.commands.run("which extensions")
            assert result.exit_code == 0
            assert "/usr/bin/extensions" in result.stdout
