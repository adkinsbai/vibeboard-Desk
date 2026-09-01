#!/usr/bin/env python3
import json

BUILD_ID = "makivo-pixel-radio"
PROMPT = "A bundled local pixel radio for MAKIVO One with lyrics and reactive visuals."

payload = {
    "build_id": BUILD_ID,
    "prompt": PROMPT,
    "runtime": "local_device_app",
    "offline": True,
    "available_apis": ["/api/status", "./hardware-result.json"],
    "display": {"width": 480, "height": 360, "touch": False},
    "audio": {"output": "speaker", "source": "bundled_embedded_synth", "remote_stream": False},
    "catalog": {"source": "bundled", "tracks": 6, "lyrics": True, "visualizer": True},
    "controls": {"play_pause": "space", "previous": "left", "next": "right"},
}

print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
