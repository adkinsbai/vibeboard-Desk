#!/usr/bin/env python3
import json
import sys

BUILD_ID = 'vb-mpyaxk4g-3b5b50'
PROMPT = '城市天气屏 - 按空格切换天气'

def main():
    result = {
        "build_id": BUILD_ID,
        "prompt": PROMPT,
        "runtime": "executed_on_board",
        "available_apis": ["/api/status", "./hardware-result.json"],
        "weather_types": ["sunny","cloudy","rainy","snowy","haily","night"],
        "description": "城市天气屏，背景包含楼房和小树，按空格键切换天气"
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()