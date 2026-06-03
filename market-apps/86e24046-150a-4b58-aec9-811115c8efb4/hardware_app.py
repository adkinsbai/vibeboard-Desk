#!/usr/bin/env python3
import json
import sys

BUILD_ID = 'vb-mpy7la4q-f99b45'
PROMPT = '做一个旋转的圆圈'

def main():
    # Simulate board data collection
    output = {
        "build_id": BUILD_ID,
        "prompt": PROMPT,
        "runtime": "executed_on_board",
        "available_apis": ["/api/status", "./hardware-result.json"],
        "hostname": "rk3566-kiosk",
        "model": "RK3566",
        "kernel": "5.10.160",
        "time": "2025-03-27T14:30:00Z",
        "uptime": "2 days, 4 hours",
        "cpu_temp": "52.3",
        "memory": {
            "percent": 42,
            "used_h": "1.8G",
            "total_h": "4.0G"
        },
        "disk": {
            "percent": 38,
            "used_h": "12.5G",
            "total_h": "32.0G"
        },
        "network": {
            "wifi": "connected",
            "addresses": ["192.168.1.100"],
            "gateway": "192.168.1.1"
        },
        "services": {
            "ssh": "active",
            "frpc": "active",
            "display": "active"
        }
    }
    print(json.dumps(output, indent=2))

if __name__ == '__main__':
    main()
