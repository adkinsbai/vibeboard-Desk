# 0002. Standalone Digital Life Companion

The Digital Life Companion remains a standalone page and backend slice instead of being embedded into the main VibeBoard dashboard.

This is accepted because the main dashboard is optimized for generated-app creation, verification, and deployment, while the companion owns a different workflow: chat-first interaction, memory, cognition, speech, presence, and autonomous runtime state.

The companion may share server infrastructure, model settings, and hardware adapters, but its user interface should stay reachable as its own experience and its routes should remain grouped under `/api/digital-life/*`.
