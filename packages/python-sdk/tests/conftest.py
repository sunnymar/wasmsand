import shutil


def pytest_collection_modifyitems(config, items):
    """Skip all tests if Deno is not available."""
    if shutil.which("deno") is None:
        import pytest

        skip = pytest.mark.skip(reason="Deno not found on PATH")
        for item in items:
            item.add_marker(skip)
