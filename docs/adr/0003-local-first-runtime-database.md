# 0003. Local-First Runtime Database

The prototype uses local SQLite file persistence through sql.js for runtime state, generated conversations, job state, assets, and platform-side memory.

This is accepted because it keeps the Windows and RK3566 prototype portable, easy to inspect, and easy to back up without requiring a separate database service.

Code that writes runtime state should keep database ownership clear. Tests should isolate database paths with `VIBEBOARD_DB_PATH`, and manual recovery steps should avoid editing the live runtime database while a server process is using it.
