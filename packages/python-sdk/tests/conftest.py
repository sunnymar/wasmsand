import shutil


def pytest_collection_modifyitems(config, items):
    """Skip all tests if Bun is not available."""
    if shutil.which("bun") is None:
        import pytest

        skip = pytest.mark.skip(reason="Bun not found on PATH")
        for item in items:
            item.add_marker(skip)
