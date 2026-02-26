"""Extension system integration tests for the Python SDK.

Tests the full round-trip: Python host registers extension -> sandbox runs it
-> handler called -> result returned.
"""
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
            assert "/bin/myext" in result.stdout


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
