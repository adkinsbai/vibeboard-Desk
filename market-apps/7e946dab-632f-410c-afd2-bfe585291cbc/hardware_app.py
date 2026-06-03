#!/usr/bin/env python3
import json

BUILD_ID = "vb-mpy89n16-6787ab"
PROMPT = "帮我做一个像素化背景的庄园，里面有两个小人在到处乱走，还有一头牛"

# Simulated hardware status (on real board this would query /sys/class, etc.)
status = {
    "hostname": "rk3566-manor",
    "model": "RK3566",
    "kernel": "5.10.160",
    "time": "2025-04-09 14:30:00",
    "uptime": "2 days, 4 hours",
    "cpu_temp": "52.3 C",
    "memory": {
        "percent": 34,
        "used_h": "1.2G",
        "total_h": "3.8G"
    },
    "disk": {
        "percent": 28,
        "used_h": "7.5G",
        "total_h": "28G"
    },
    "network": {
        "wifi": "connected",
        "addresses": ["192.168.1.42"],
        "gateway": "192.168.1.1"
    },
    "services": {
        "ssh": "active",
        "frpc": "active",
        "display": "active"
    },
    "available_apis": ["/api/status", "./hardware-result.json"],
    "runtime": "executed_on_board",
    "build_id": BUILD_ID
}

print(json.dumps(status, indent=2))