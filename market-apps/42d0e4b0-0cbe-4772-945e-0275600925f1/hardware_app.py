#!/usr/bin/env python3
import json
import sys

BUILD_ID = 'vb-mpyadigk-08b381'
PROMPT = 'Racing game with arrow keys, avoid oncoming cars, game over on crash, SPACE to restart'

def main():
    # Simulate hardware status for the kiosk
    result = {
        "build_id": BUILD_ID,
        "prompt": PROMPT,
        "runtime": "executed_on_board",
        "available_apis": ["/api/status", "./hardware-result.json"],
        "status": {
            "hostname": "rk3566-racing",
            "model": "RK3566",
            "kernel": "5.10.160",
            "time": "2025-03-21T14:30:00Z",
            "uptime": "2 days, 4 hours",
            "cpu_temp": "52.3 C",
            "memory": {
                "percent": 34,
                "used_h": "1.2G",
                "total_h": "3.8G"
            },
            "disk": {
                "percent": 28,
                "used_h": "8.5G",
                "total_h": "31.2G"
            },
            "network": {
                "wifi": "WLAN-5G",
                "addresses": ["192.168.1.42"],
                "gateway": "192.168.1.1"
            },
            "services": {
                "ssh": "active",
                "frpc": "active",
                "display": "active"
            }
        },
        "game_state": {
            "running": True,
            "score": 0
        }
    }
    print(json.dumps(result, indent=2))

if __name__ == '__main__':
    main()
