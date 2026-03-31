"""Tests for CPU control features: nice param and suspend/resume methods."""
from __future__ import annotations

import pytest
from unittest.mock import MagicMock, patch

from codepod.sandbox import Sandbox


class TestNiceParam:
    def test_nice_included_in_create_params_for_wasmtime(self):
        """nice param is sent in create RPC when using wasmtime engine."""
        captured = {}

        class FakeClient:
            def start(self): pass
            def register_storage_handlers(self, **_): pass
            def call(self, method, params):
                captured[method] = params
                if method == "create":
                    return {"ok": True}
                return {}

        with patch("codepod.sandbox._resolve_runtime", return_value=("/fake/codepod-server", [], None, None)), \
             patch("codepod.sandbox._find_codepod_server", return_value="/fake/codepod-server"), \
             patch("codepod.sandbox.RpcClient", return_value=FakeClient()):
            _ = Sandbox(engine="wasmtime", nice=10)

        assert captured["create"].get("nice") == 10

    def test_nice_clamped_to_19(self):
        """nice values above 19 are clamped."""
        captured = {}

        class FakeClient:
            def start(self): pass
            def register_storage_handlers(self, **_): pass
            def call(self, method, params):
                captured[method] = params
                return {"ok": True}

        with patch("codepod.sandbox._resolve_runtime", return_value=("/fake/codepod-server", [], None, None)), \
             patch("codepod.sandbox._find_codepod_server", return_value="/fake/codepod-server"), \
             patch("codepod.sandbox.RpcClient", return_value=FakeClient()):
            _ = Sandbox(engine="wasmtime", nice=99)

        assert captured["create"].get("nice") == 19

    def test_nice_zero_not_sent(self):
        """nice=0 (default) is not included in create params (saves bandwidth)."""
        captured = {}

        class FakeClient:
            def start(self): pass
            def register_storage_handlers(self, **_): pass
            def call(self, method, params):
                captured[method] = params
                return {"ok": True}

        with patch("codepod.sandbox._resolve_runtime", return_value=("/fake/codepod-server", [], None, None)), \
             patch("codepod.sandbox._find_codepod_server", return_value="/fake/codepod-server"), \
             patch("codepod.sandbox.RpcClient", return_value=FakeClient()):
            _ = Sandbox(engine="wasmtime", nice=0)

        assert "nice" not in captured["create"]


class TestSuspendResume:
    def _make_wasmtime_sandbox(self):
        """Create a Sandbox with mocked wasmtime engine."""
        fake_client = MagicMock()
        fake_client.call.return_value = {"ok": True}

        with patch("codepod.sandbox._resolve_runtime", return_value=("/fake/codepod-server", [], None, None)), \
             patch("codepod.sandbox._find_codepod_server", return_value="/fake/codepod-server"), \
             patch("codepod.sandbox.RpcClient", return_value=fake_client):
            sb = Sandbox(engine="wasmtime")
        sb._client = fake_client
        return sb, fake_client

    def _make_deno_sandbox(self):
        """Create a Sandbox with mocked deno engine."""
        fake_client = MagicMock()
        fake_client.call.return_value = {"ok": True}

        with patch("codepod.sandbox._resolve_runtime", return_value=("/fake/deno", ["run", "server.ts"], "/wasm", "/wasm/shell.wasm")), \
             patch("codepod.sandbox._find_codepod_server", return_value=None), \
             patch("codepod.sandbox.RpcClient", return_value=fake_client):
            sb = Sandbox(engine="deno")
        sb._client = fake_client
        return sb, fake_client

    def test_suspend_calls_rpc_on_wasmtime(self):
        sb, client = self._make_wasmtime_sandbox()
        sb.suspend()
        client.call.assert_called_with("sandbox.suspend", {})

    def test_resume_calls_rpc_on_wasmtime(self):
        sb, client = self._make_wasmtime_sandbox()
        sb.resume()
        client.call.assert_called_with("sandbox.resume", {})

    def test_suspend_raises_on_deno(self):
        sb, _ = self._make_deno_sandbox()
        with pytest.raises(NotImplementedError, match="wasmtime"):
            sb.suspend()

    def test_resume_raises_on_deno(self):
        sb, _ = self._make_deno_sandbox()
        with pytest.raises(NotImplementedError, match="wasmtime"):
            sb.resume()
