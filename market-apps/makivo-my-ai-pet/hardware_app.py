#!/usr/bin/env python3
import json

BUILD_ID = "makivo-my-ai-pet"
PROMPT = "A local voice-created pixel pet for MAKIVO One."

payload = {
    "build_id": BUILD_ID,
    "prompt": PROMPT,
    "runtime": "local_device_app",
    "offline": True,
    "available_apis": ["/api/status", "./hardware-result.json"],
    "display": {"width": 480, "height": 360, "touch": False},
    "audio": {"playback": "speaker", "recording": "microphone", "remote_services": False},
    "controls": {"voice": "create_pet", "text_fallback": True},
}

print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
