#!/usr/bin/env python3
import json
import sys

BUILD_ID = "vb-mpya9p0j-4f4459"
PROMPT = "给我生成一个虚拟的热带鱼缸，里面有海草和鱼，还有石头"

def main():
    result = {
        "build_id": BUILD_ID,
        "prompt": PROMPT,
        "runtime": "executed_on_board",
        "available_apis": ["/api/status", "./hardware-result.json"],
        "tank": {
            "fish_count": 6,
            "seaweed_count": 8,
            "rock_count": 6,
            "bubble_count": 12,
            "status": "simulated_healthy"
        },
        "board_info": {
            "model": "RK3566",
            "display": "480x360"
        }
    }
    print(json.dumps(result, indent=2))

if __name__ == "__main__":
    main()