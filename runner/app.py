from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field


MAX_FILE_BYTES = int(os.getenv("PYTHON_RUNNER_MAX_FILE_BYTES", str(2 * 1024 * 1024)))
MAX_TOTAL_BYTES = int(os.getenv("PYTHON_RUNNER_MAX_TOTAL_BYTES", str(8 * 1024 * 1024)))
DEFAULT_TIMEOUT_MS = int(os.getenv("PYTHON_RUNNER_TIMEOUT_MS", "15000"))
HARDWARE_RESULT_FILE = "hardware-result.json"
SCREEN_WIDTH = 480
SCREEN_HEIGHT = 360
RENDER_SETTLE_MS = 250
MIN_READABLE_FONT_PX = 10
MIN_INTERACTIVE_TARGET_PX = 28
MIN_TEXT_CONTRAST_RATIO = 3
MAX_READABILITY_SAMPLES = 12

app = FastAPI(title="VibeBoard Python Runner", version="0.1.0")


class ExecuteRequest(BaseModel):
    mode: str = Field(default="run", pattern="^(compile|run)$")
    entry: str = "hardware_app.py"
    timeoutMs: int | None = None
    files: dict[str, Any] = Field(default_factory=dict)


class RenderRequest(BaseModel):
    timeoutMs: int | None = None
    files: dict[str, Any] = Field(default_factory=dict)


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "vibeboard-python-render-runner",
        "python": sys.version.split()[0],
        "render": True,
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


@app.post("/v1/render/verify")
def verify_render(req: RenderRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    verify_token(authorization)
    timeout_ms = max(1000, min(60000, int(req.timeoutMs or DEFAULT_TIMEOUT_MS)))

    with tempfile.TemporaryDirectory(prefix="vibeboard-render-runner-") as temp:
        root = Path(temp).resolve()
        write_request_files(root, req.files)
        if not (root / "index.html").exists():
            raise HTTPException(status_code=400, detail="index.html is required")
        if not (root / HARDWARE_RESULT_FILE).exists():
            (root / HARDWARE_RESULT_FILE).write_text(json.dumps(mock_hardware_result()), encoding="utf-8")
        return run_render_verification(root, timeout_ms)


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
        return base64.b64decode(str(value.get("data") or value.get("content") or ""))
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


def run_render_verification(root: Path, timeout_ms: int) -> dict[str, Any]:
    try:
        from playwright.sync_api import sync_playwright
    except Exception as exc:
        return render_tool_result(
            ok=False,
            summary="Render runner could not import Playwright.",
            issues=[{
                "code": "RENDER_RUNNER_PLAYWRIGHT_UNAVAILABLE",
                "message": str(exc),
                "phase": "render",
                "evidence": {},
                "suggestedFixes": ["Install Playwright and Chromium in the runner environment."],
            }],
            evidence={"runner": "python-playwright"},
        )

    server = RenderHttpServer(root)
    server.start()
    browser = None
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": SCREEN_WIDTH, "height": SCREEN_HEIGHT}, device_scale_factor=1)
            console_errors: list[str] = []
            page_errors: list[str] = []
            failed_requests: list[dict[str, Any]] = []
            responses: list[dict[str, Any]] = []

            page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
            page.on("pageerror", lambda err: page_errors.append(str(err)))
            page.on("requestfailed", lambda req: failed_requests.append({
                "url": req.url,
                "method": req.method,
                "failure": req.failure or "request failed",
            }))
            page.on("response", lambda res: responses.append({"url": res.url, "status": res.status}) if res.status >= 400 else None)

            target_url = f"http://127.0.0.1:{server.port}/index.html"
            page.goto(target_url, wait_until="domcontentloaded", timeout=timeout_ms)
            try:
                page.wait_for_load_state("networkidle", timeout=min(timeout_ms, 5000))
            except Exception:
                pass
            page.wait_for_timeout(RENDER_SETTLE_MS)

            page_state = page.evaluate(PAGE_STATE_SCRIPT)
            readability_state = page.evaluate(READABILITY_SCRIPT, {
                "minReadableFontPx": MIN_READABLE_FONT_PX,
                "minInteractiveTargetPx": MIN_INTERACTIVE_TARGET_PX,
                "minTextContrastRatio": MIN_TEXT_CONTRAST_RATIO,
                "maxSamples": MAX_READABILITY_SAMPLES,
            })

            screenshot_bytes = page.screenshot(full_page=False)
            screenshot = {
                "encoding": "base64",
                "content": base64.b64encode(screenshot_bytes).decode("ascii"),
                "mimeType": "image/png",
                "bytes": len(screenshot_bytes),
            }
            issues = render_issues(page_state, readability_state, console_errors, page_errors, failed_requests, responses)
            blocking = [issue for issue in issues if issue.get("severity") not in ("warning", "info")]
            summary = (
                "480x360 HTTP render failed."
                if blocking else
                "480x360 HTTP render passed with hardware-fit warnings."
                if issues else
                "480x360 HTTP render passed."
            )

            return render_tool_result(
                ok=not blocking,
                summary=summary,
                issues=issues,
                degraded=not blocking and bool(issues),
                evidence={
                    "runner": "python-playwright",
                    "targetUrl": target_url,
                    "pageState": page_state,
                    "readabilityState": readability_state,
                    "consoleErrors": console_errors,
                    "pageErrors": page_errors,
                    "failedRequests": failed_requests,
                    "badResponses": responses,
                    "screenshot": {
                        "mimeType": screenshot["mimeType"],
                        "bytes": screenshot["bytes"],
                    },
                },
                data={
                    "screenshot": screenshot,
                },
            )
    except Exception as exc:
        return render_tool_result(
            ok=False,
            summary="Render verification could not complete.",
            issues=[{
                "code": "RENDER_VERIFIER_ERROR",
                "message": str(exc),
                "phase": "render",
                "evidence": {},
                "suggestedFixes": ["Check that Playwright Chromium is installed and that index.html/app.js can load over HTTP."],
            }],
            evidence={"runner": "python-playwright"},
        )
    finally:
        if browser:
            try:
                browser.close()
            except Exception:
                pass
        server.close()


def render_tool_result(
    ok: bool,
    summary: str,
    issues: list[dict[str, Any]] | None = None,
    evidence: dict[str, Any] | None = None,
    data: Any = None,
    degraded: bool = False,
) -> dict[str, Any]:
    normalized = []
    for issue in issues or []:
        item = {
            "phase": "render",
            "severity": "blocking",
            "suggestedFixes": [],
            **issue,
        }
        normalized.append(item)
    return {
        "ok": bool(ok) and not any(issue.get("severity") == "blocking" for issue in normalized),
        "phase": "render",
        "summary": summary,
        "issues": normalized,
        "evidence": evidence or {},
        "data": data,
        "degraded": bool(degraded),
    }


def render_issues(
    page_state: dict[str, Any],
    readability_state: dict[str, Any],
    console_errors: list[str],
    page_errors: list[str],
    failed_requests: list[dict[str, Any]],
    responses: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    if int(page_state.get("bodyHtmlLength") or 0) < 50 and int(page_state.get("textLength") or 0) < 5:
        issues.append({
            "code": "RENDER_BLANK",
            "message": "Rendered page appears blank.",
            "phase": "render",
            "evidence": page_state,
            "suggestedFixes": ["Ensure index.html contains a mounted screen and app.js writes visible content."],
        })
    if int(page_state.get("scrollWidth") or 0) > SCREEN_WIDTH or int(page_state.get("scrollHeight") or 0) > SCREEN_HEIGHT:
        issues.append({
            "code": "LAYOUT_OVERFLOW",
            "message": f"Rendered page overflows {SCREEN_WIDTH}x{SCREEN_HEIGHT}.",
            "phase": "render",
            "evidence": page_state,
            "suggestedFixes": [
                f"Constrain html, body, and the root app surface to {SCREEN_WIDTH}px by {SCREEN_HEIGHT}px.",
                "Use overflow: hidden and reduce gaps or fixed-size panels that exceed the screen.",
            ],
        })
    if console_errors:
        issues.append({
            "code": "CONSOLE_ERRORS",
            "message": f"Rendered page emitted {len(console_errors)} console error(s).",
            "phase": "render",
            "evidence": {"consoleErrors": console_errors[:10]},
            "suggestedFixes": ["Fix JavaScript errors and failed resource handling reported in the browser console."],
        })
    if page_errors:
        issues.append({
            "code": "PAGE_ERRORS",
            "message": f"Rendered page threw {len(page_errors)} page error(s).",
            "phase": "render",
            "evidence": {"pageErrors": page_errors[:10]},
            "suggestedFixes": ["Fix uncaught runtime exceptions in app.js."],
        })
    if int(readability_state.get("tinyTextCount") or 0) > 0:
        issues.append({
            "code": "TEXT_TOO_SMALL",
            "message": f"Rendered page has {readability_state.get('tinyTextCount')} visible text block(s) below {MIN_READABLE_FONT_PX}px.",
            "phase": "render",
            "evidence": {
                "minReadableFontPx": MIN_READABLE_FONT_PX,
                "samples": readability_state.get("tinyTextSamples") or [],
            },
            "suggestedFixes": [
                f"Use at least {MIN_READABLE_FONT_PX}px for visible text on the 480x360 hardware screen.",
                "Reduce secondary metadata, spacing, or item count instead of shrinking labels below the readability floor.",
            ],
        })
    if int(readability_state.get("lowContrastTextCount") or 0) > 0:
        issues.append({
            "code": "TEXT_CONTRAST_LOW",
            "message": f"Rendered page has {readability_state.get('lowContrastTextCount')} visible text block(s) below {MIN_TEXT_CONTRAST_RATIO}:1 contrast.",
            "phase": "render",
            "evidence": {
                "minTextContrastRatio": MIN_TEXT_CONTRAST_RATIO,
                "samples": readability_state.get("lowContrastSamples") or [],
            },
            "suggestedFixes": [
                f"Raise text/background contrast to at least {MIN_TEXT_CONTRAST_RATIO}:1 on the 480x360 hardware screen.",
                "Use stronger foreground colors, darker/lighter backing surfaces, or remove decorative low-contrast labels.",
            ],
        })
    if int(readability_state.get("smallInteractiveCount") or 0) > 0:
        issues.append({
            "code": "INTERACTIVE_TARGET_SMALL",
            "severity": "warning",
            "message": f"Rendered page has {readability_state.get('smallInteractiveCount')} visible interactive target(s) below {MIN_INTERACTIVE_TARGET_PX}px.",
            "phase": "render",
            "evidence": {
                "minInteractiveTargetPx": MIN_INTERACTIVE_TARGET_PX,
                "samples": readability_state.get("smallInteractiveSamples") or [],
            },
            "suggestedFixes": [
                f"Keep interactive controls at least {MIN_INTERACTIVE_TARGET_PX}px wide and tall, or replace them with passive status indicators for no-touch hardware.",
            ],
        })
    bad_network = [
        item for item in [*failed_requests, *responses]
        if not str(item.get("url") or "").startswith(("data:", "blob:"))
    ]
    if bad_network:
        issues.append({
            "code": "NETWORK_ERRORS",
            "message": f"Rendered page had {len(bad_network)} failed or non-2xx resource request(s).",
            "phase": "render",
            "evidence": {"network": bad_network[:10]},
            "suggestedFixes": ["Use only local relative assets and ensure /api/status plus ./hardware-result.json are handled."],
        })
    return issues


class RenderHttpServer:
    def __init__(self, root: Path):
        self.root = root
        self.httpd: ThreadingHTTPServer | None = None
        self.thread: threading.Thread | None = None
        self.port = 0

    def start(self) -> None:
        root = self.root

        class Handler(SimpleHTTPRequestHandler):
            def __init__(self, *args: Any, **kwargs: Any) -> None:
                super().__init__(*args, directory=str(root), **kwargs)

            def log_message(self, format: str, *args: Any) -> None:
                return

            def do_GET(self) -> None:
                if self.path.split("?", 1)[0] == "/api/status":
                    self.send_json(mock_board_status())
                    return
                super().do_GET()

            def end_headers(self) -> None:
                self.send_header("Cache-Control", "no-store")
                super().end_headers()

            def send_json(self, value: dict[str, Any], status: int = 200) -> None:
                data = json.dumps(value).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = int(self.httpd.server_address[1])
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        time.sleep(0.05)

    def close(self) -> None:
        if self.httpd:
            self.httpd.shutdown()
            self.httpd.server_close()
        if self.thread:
            self.thread.join(timeout=2)


def mock_hardware_result() -> dict[str, Any]:
    return {
        "ok": True,
        "mode": "mock",
        "build_id": "mock-render",
        "runtime": "python-render-runner-mock",
        "available_apis": ["/api/status", "./hardware-result.json"],
        "created_at": "runner",
    }


def mock_board_status() -> dict[str, Any]:
    return {
        "ok": True,
        "connected": True,
        "mode": "mock",
        "hostname": "vibeboard-render-runner",
        "model": "RK3566 Taishan Gray Mock",
        "kernel": "mock",
        "time": "runner",
        "uptime": "mock",
        "cpu_temp": 42,
        "memory": {"percent": 38, "used_h": "380M", "total_h": "1G"},
        "disk": {"percent": 24, "used_h": "2.4G", "total_h": "10G"},
        "network": {"wifi": "mock-wifi", "addresses": ["127.0.0.1"], "gateway": "127.0.0.1"},
        "services": {"ssh": "mock", "frpc": "mock", "display": "mock"},
    }


PAGE_STATE_SCRIPT = """
() => {
  const body = document.body;
  const html = document.documentElement;
  const root = document.querySelector("main") || document.querySelector("#app") || body;
  const rect = root?.getBoundingClientRect?.();
  const text = body?.innerText || "";
  const style = window.getComputedStyle(body);
  return {
    bodyHtmlLength: body?.innerHTML?.trim?.().length || 0,
    textLength: text.trim().length,
    scrollWidth: html.scrollWidth,
    scrollHeight: html.scrollHeight,
    bodyScrollWidth: body?.scrollWidth || 0,
    bodyScrollHeight: body?.scrollHeight || 0,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    rootWidth: rect?.width || 0,
    rootHeight: rect?.height || 0,
    bodyOverflow: style.overflow,
    bodyOverflowX: style.overflowX,
    bodyOverflowY: style.overflowY,
  };
}
"""


READABILITY_SCRIPT = r"""
(config) => {
  const tinyTextSamples = [];
  const lowContrastSamples = [];
  const smallInteractiveSamples = [];
  let tinyTextCount = 0;
  let lowContrastTextCount = 0;
  let smallInteractiveCount = 0;
  let visibleTextBlockCount = 0;
  let interactiveCount = 0;

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || 1) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0.5 && rect.height > 0.5;
  }

  function compactText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function directText(el) {
    return compactText(Array.from(el.childNodes)
      .filter(node => node.nodeType === Node.TEXT_NODE)
      .map(node => node.textContent || "")
      .join(" "));
  }

  function hasVisibleTextChild(el) {
    return Array.from(el.children || []).some(child => isVisible(child) && compactText(child.innerText).length > 0);
  }

  function sampleFor(el, text, fontSize, rect) {
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || "",
      className: typeof el.className === "string" ? el.className.slice(0, 120) : "",
      text: compactText(text).slice(0, 80),
      fontSize,
      color: window.getComputedStyle(el).color,
      backgroundColor: effectiveBackgroundColor(el),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }

  function parseRgb(value) {
    const text = String(value || "").trim();
    if (text.toLowerCase() === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
    const match = text.match(/^rgba?\(([^)]+)\)$/i);
    if (!match) return null;
    const body = match[1].replace(/\s*\/\s*/g, " ").trim();
    const parts = (body.includes(",") ? body.split(",") : body.split(/\s+/))
      .map(part => Number.parseFloat(part.trim()));
    if (parts.length < 3 || parts.slice(0, 3).some(part => Number.isNaN(part))) return null;
    return {
      r: Math.max(0, Math.min(255, parts[0])),
      g: Math.max(0, Math.min(255, parts[1])),
      b: Math.max(0, Math.min(255, parts[2])),
      a: parts.length >= 4 && !Number.isNaN(parts[3]) ? Math.max(0, Math.min(1, parts[3])) : 1,
    };
  }

  function representativeBackgroundImageColor(value) {
    const matches = String(value || "").match(/rgba?\([^)]+\)|transparent/gi) || [];
    const colors = matches.map(item => parseRgb(item)).filter(color => color && color.a > 0.01);
    if (!colors.length) return null;
    let total = 0, r = 0, g = 0, b = 0, alpha = 0;
    for (const color of colors) {
      const weight = Math.max(color.a ?? 1, 0.05);
      r += color.r * weight; g += color.g * weight; b += color.b * weight;
      total += weight; alpha = Math.max(alpha, color.a ?? 1);
    }
    if (total <= 0) return null;
    return { r: r / total, g: g / total, b: b / total, a: alpha };
  }

  function blend(fg, bg) {
    const alpha = fg.a == null ? 1 : fg.a;
    return {
      r: fg.r * alpha + bg.r * (1 - alpha),
      g: fg.g * alpha + bg.g * (1 - alpha),
      b: fg.b * alpha + bg.b * (1 - alpha),
      a: 1,
    };
  }

  function effectiveBackgroundColor(el) {
    const white = { r: 255, g: 255, b: 255, a: 1 };
    const backgroundStack = [];
    let current = el;
    while (current && current instanceof Element) {
      const currentStyle = window.getComputedStyle(current);
      const imageColor = representativeBackgroundImageColor(currentStyle.backgroundImage);
      if (imageColor && imageColor.a > 0) backgroundStack.push(imageColor);
      const parsed = parseRgb(currentStyle.backgroundColor);
      if (parsed && parsed.a > 0) backgroundStack.push(parsed);
      current = current.parentElement;
    }
    let background = white;
    for (const layer of backgroundStack.reverse()) background = blend(layer, background);
    return background;
  }

  function channelLuminance(channel) {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }

  function relativeLuminance(color) {
    return 0.2126 * channelLuminance(color.r)
      + 0.7152 * channelLuminance(color.g)
      + 0.0722 * channelLuminance(color.b);
  }

  function contrastRatio(fg, bg) {
    const foreground = fg.a != null && fg.a < 1 ? blend(fg, bg) : fg;
    const l1 = relativeLuminance(foreground);
    const l2 = relativeLuminance(bg);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }

  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    if (!isVisible(el)) continue;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const text = directText(el) || (!hasVisibleTextChild(el) ? compactText(el.innerText) : "");

    if (text.length >= 2) {
      const fontSize = Number.parseFloat(style.fontSize) || 0;
      visibleTextBlockCount += 1;
      if (fontSize > 0 && fontSize < config.minReadableFontPx) {
        tinyTextCount += 1;
        if (tinyTextSamples.length < config.maxSamples) tinyTextSamples.push(sampleFor(el, text, fontSize, rect));
      }
      const color = parseRgb(style.color);
      const backgroundColor = effectiveBackgroundColor(el);
      if (color && backgroundColor) {
        const ratio = contrastRatio(color, backgroundColor);
        if (ratio < config.minTextContrastRatio) {
          lowContrastTextCount += 1;
          if (lowContrastSamples.length < config.maxSamples) {
            lowContrastSamples.push({ ...sampleFor(el, text, fontSize, rect), contrastRatio: Number(ratio.toFixed(2)) });
          }
        }
      }
    }

    const tag = el.tagName.toLowerCase();
    const role = String(el.getAttribute("role") || "").toLowerCase();
    const interactive = ["button", "a", "input", "select", "textarea"].includes(tag)
      || ["button", "link", "switch", "checkbox", "radio", "tab"].includes(role)
      || el.hasAttribute("onclick");
    if (interactive) {
      interactiveCount += 1;
      if (rect.width < config.minInteractiveTargetPx || rect.height < config.minInteractiveTargetPx) {
        smallInteractiveCount += 1;
        if (smallInteractiveSamples.length < config.maxSamples) {
          smallInteractiveSamples.push(sampleFor(el, compactText(el.innerText || el.getAttribute("aria-label") || tag), Number.parseFloat(style.fontSize) || 0, rect));
        }
      }
    }
  }

  return {
    minReadableFontPx: config.minReadableFontPx,
    minInteractiveTargetPx: config.minInteractiveTargetPx,
    minTextContrastRatio: config.minTextContrastRatio,
    textLength: compactText(document.body.innerText).length,
    visibleTextBlockCount,
    tinyTextCount,
    tinyTextSamples,
    lowContrastTextCount,
    lowContrastSamples,
    interactiveCount,
    smallInteractiveCount,
    smallInteractiveSamples,
  };
}
"""
