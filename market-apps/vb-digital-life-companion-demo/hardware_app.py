import json

BUILD_ID = "vb-digital-life-companion-demo"
PROMPT = "Verified local Digital Life companion market demo"
available_apis = ["/api/status", "./hardware-result.json"]

payload = {
    "build_id": BUILD_ID,
    "prompt": PROMPT,
    "runtime": {"mode": "market_demo", "executed_on_board": False},
    "available_apis": available_apis,
    "controls": {"KEY1": "expression", "KEY2": "memory", "KEY3": "skin"},
}

with open("hardware-result.json", "w", encoding="utf-8") as handle:
    handle.write(json.dumps(payload, ensure_ascii=False))

print(json.dumps(payload, ensure_ascii=False))
