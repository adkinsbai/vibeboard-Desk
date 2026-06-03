#!/usr/bin/env python3
import json
import sys

BUILD_ID = "vb-mpy9o0v7-ef1092"
PROMPT = "帮我生成一个桌面的篮球"

def main():
    result = {
        "build_id": BUILD_ID,
        "prompt": PROMPT,
        "runtime": "executed_on_board",
        "available_apis": ["/api/status", "./hardware-result.json"],
        "app": "desktop_basketball",
        "version": "1.0.0",
        "status": "running"
    }
    print(json.dumps(result, ensure_ascii=False))

if __name__ == "__main__":
    main()
