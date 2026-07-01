from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field


MAX_FILE_BYTES = int(os.getenv("PYTHON_RUNNER_MAX_FILE_BYTES", str(512 * 1024)))
MAX_TOTAL_BYTES = int(os.getenv("PYTHON_RUNNER_MAX_TOTAL_BYTES", str(2 * 1024 * 1024)))
DEFAULT_TIMEOUT_MS = int(os.getenv("PYTHON_RUNNER_TIMEOUT_MS", "15000"))
HARDWARE_RESULT_FILE = "hardware-result.json"

app = FastAPI(title="VibeBoard Python Runner", version="0.1.0")


class ExecuteRequest(BaseModel):
    mode: str = Field(default="run", pattern="^(compile|run)$")
    entry: str = "hardware_app.py"
    timeoutMs: int | None = None
    files: dict[str, Any] = Field(default_factory=dict)


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "vibeboard-python-runner",
        "python": sys.version.split()[0],
    }


@app.post("/v1/python/execute")
def execute_python(req: ExecuteRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    verify_token(authorization)
    timeout_s = max(1, min(60, int(req.timeoutMs or DEFAULT_TIMEOUT_MS) / 1000))

    with tempfile.TemporaryDirectory(prefix="vibeboard-runner-") as temp:
        root = Path(temp).resolve()
        write_request_files(root, req.files)
        entry = safe_path(root, req.entry)
        if not entry.exists():
            raise HTTPException(status_code=400, detail=f"entry file not found: {req.entry}")

        command = [sys.executable, "-m", "py_compile", str(entry)] if req.mode == "compile" else [sys.executable, str(entry)]
        try:
            result = subprocess.run(
                command,
                cwd=str(root),
                capture_output=True,
                text=True,
                timeout=timeout_s,
            )
        except subprocess.TimeoutExpired as exc:
            return {
                "ok": False,
                "mode": req.mode,
                "entry": req.entry,
                "exitCode": 124,
                "stdout": exc.stdout or "",
                "stderr": (exc.stderr or "") + f"\nTimed out after {timeout_s:.1f}s",
                "files": read_output_files(root),
            }

        return {
            "ok": result.returncode == 0,
            "mode": req.mode,
            "entry": req.entry,
            "exitCode": result.returncode,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "files": read_output_files(root),
        }


def verify_token(authorization: str | None) -> None:
    token = os.getenv("PYTHON_RUNNER_TOKEN", "").strip()
    if not token:
        return
    expected = f"Bearer {token}"
    if authorization != expected:
        raise HTTPException(status_code=401, detail="invalid runner token")


def write_request_files(root: Path, files: dict[str, Any]) -> None:
    total = 0
    for name, value in files.items():
        target = safe_path(root, name)
        data = decode_file_value(value)
        total += len(data)
        if len(data) > MAX_FILE_BYTES:
            raise HTTPException(status_code=413, detail=f"file too large: {name}")
        if total > MAX_TOTAL_BYTES:
            raise HTTPException(status_code=413, detail="request files too large")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)


def decode_file_value(value: Any) -> bytes:
    if isinstance(value, str):
        return value.encode("utf-8")
    if isinstance(value, dict) and value.get("encoding") == "base64":
        return base64.b64decode(str(value.get("content") or ""))
    if isinstance(value, dict) and "content" in value:
        return str(value.get("content") or "").encode("utf-8")
    return json.dumps(value, ensure_ascii=False).encode("utf-8")


def read_output_files(root: Path) -> dict[str, Any]:
    result_path = root / HARDWARE_RESULT_FILE
    if not result_path.exists() or not result_path.is_file():
        return {}
    content = result_path.read_bytes()
    if len(content) > MAX_FILE_BYTES:
        return {}
    try:
        return {HARDWARE_RESULT_FILE: content.decode("utf-8")}
    except UnicodeDecodeError:
        return {
            HARDWARE_RESULT_FILE: {
                "encoding": "base64",
                "content": base64.b64encode(content).decode("ascii"),
            }
        }


def safe_path(root: Path, name: str) -> Path:
    raw = str(name or "").replace("\\", "/").lstrip("/")
    if not raw or raw.endswith("/"):
        raise HTTPException(status_code=400, detail=f"invalid file path: {name}")
    target = (root / raw).resolve()
    if target != root and root not in target.parents:
        raise HTTPException(status_code=400, detail=f"unsafe file path: {name}")
    return target

