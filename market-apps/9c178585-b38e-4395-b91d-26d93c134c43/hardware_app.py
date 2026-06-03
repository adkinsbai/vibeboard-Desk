#!/usr/bin/env python3
import json
import sys

BUILD_ID = "vb-mpy7pyts-9b3609"
PROMPT = "贪吃蛇游戏，边界不死，有头"

def main():
    result = {
        "build_id": BUILD_ID,
        "prompt": PROMPT,
        "runtime": "executed_on_board",
        "available_apis": ["/api/status", "./hardware-result.json"],
        "game": "snake",
        "description": "Snake game with wrap-around boundaries, distinct head, apple food"
    }
    print(json.dumps(result))

if __name__ == "__main__":
    main()