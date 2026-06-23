# 0001. Contract-First Hardware Generation

Generated apps are governed by `src/contracts.mjs` as the hardware-contract source of truth. The contract covers required runtime files, hardware result evidence, and the runtime API shape that generated apps must expose.

This is accepted because hardware rules are shared by generator prompts, local verification, build evidence, and smoke tests. Duplicating those rules in route handlers, prompts, and tests would make RK3566 behavior drift silently.

Build and generation runtime code may continue to move out of `server.mjs`, but they should consume the central contract instead of re-declaring it.
