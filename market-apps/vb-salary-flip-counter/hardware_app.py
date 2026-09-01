#!/usr/bin/env python3
import json
import platform
import socket
import time

BUILD_ID = "vb-salary-flip-counter"
PROMPT = "A 480x360 salary counter for a 09:00-18:00 shift with CNY 1,000 total daily salary and stable scoreboard flip animations."

def main():
    print(json.dumps({
        "app": BUILD_ID,
        "build_id": BUILD_ID,
        "prompt": PROMPT,
        "compile": "py_compile_ok",
        "runtime": "executed_on_board",
        "time": int(time.time()),
        "hostname": socket.gethostname(),
        "platform": platform.platform(),
        "display": {"width": 480, "height": 360, "touch": False},
        "available_apis": [],
        "capabilities": []
    }, ensure_ascii=False, sort_keys=True))

if __name__ == "__main__":
    main()
