#!/usr/bin/env python3
import glob
import json
import os
import platform
import shutil
import socket
import time

BUILD_ID = "vb-mpy6k44x-e85c2d"
PROMPT = "hello world test"
SPEC = {"id":"vb-mpy6k44x-e85c2d","prompt":"hello world test","mode":"assistant","title":"AI Screen Assistant","subtitle":"hello world test","accent":"#22c55e","target":"480x360 RK3566 Linux kiosk","hardwareApi":["/api/status","./hardware-result.json"],"widgets":[{"id":"wifi","label":"Wi-Fi","value":"--","hint":"live network"},{"id":"ip","label":"IP","value":"--","hint":"board address"},{"id":"temp","label":"Temp","value":"--","hint":"thermal zone"},{"id":"runtime","label":"Runtime","value":"--","hint":"python result"}],"actions":[{"id":"primary","label":"Run"},{"id":"secondary","label":"Mark"},{"id":"refresh","label":"Refresh"}]}

def read_first(path, default=""):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.readline().strip()
    except OSError:
        return default

def cpu_temp_c():
    raw = read_first("/sys/class/thermal/thermal_zone0/temp")
    try:
        value = float(raw)
        return round(value / 1000, 1) if value > 200 else round(value, 1)
    except ValueError:
        return None

def mem_available_kb():
    try:
        with open("/proc/meminfo", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1])
    except OSError:
        pass
    return None

def network_interfaces():
    items = []
    for path in glob.glob("/sys/class/net/*/operstate"):
        name = path.split("/")[-2]
        state = read_first(path, "unknown")
        if name != "lo":
            items.append({"name": name, "state": state})
    return items

def disk_percent():
    try:
        usage = shutil.disk_usage("/")
        return round((usage.used / usage.total) * 100, 1)
    except OSError:
        return None

result = {
    "app": "vibeboard-hardware-app",
    "build_id": BUILD_ID,
    "compile": "py_compile_ok",
    "runtime": "executed_on_board",
    "prompt": PROMPT,
    "spec": SPEC,
    "hostname": socket.gethostname(),
    "platform": platform.platform(),
    "time": int(time.time()),
    "cpu_temp_c": cpu_temp_c(),
    "mem_available_kb": mem_available_kb(),
    "disk_percent": disk_percent(),
    "network": network_interfaces(),
    "loadavg": read_first("/proc/loadavg"),
    "cwd": os.getcwd(),
    "available_apis": ["/api/status", "./hardware-result.json"]
}

print(json.dumps(result, ensure_ascii=False, sort_keys=True))
