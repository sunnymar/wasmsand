from dataclasses import dataclass


@dataclass
class CommandResult:
    stdout: str
    stderr: str
    exit_code: int
    execution_time_ms: float
    truncated: dict[str, bool] | None = None
    error_class: str | None = None


@dataclass
class FileInfo:
    name: str
    type: str  # "file" or "dir"
    size: int
