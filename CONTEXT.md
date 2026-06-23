# VibeBoard Context

VibeBoard is a hardware-aware application generation environment for small RK3566 display devices and a local Digital Life companion.

## Language

**Board**: A physical Linux display device that receives generated applications and exposes hardware capabilities. Avoid: target, remote box, device when meaning the physical board.

**Generated App**: A self-contained web and hardware companion bundle produced from a user prompt for the board. Avoid: project, sketch.

**Build**: A versioned generated app plus local verification evidence and deployment state. Avoid: generation when referring to the verified artifact.

**Hardware Contract**: The required runtime files, hardware result shape, and runtime APIs that every generated app must satisfy. Avoid: validation rules, prompt rules.

**Golden Loop**: The end-to-end deployment verification loop proving a generated app reaches the board and reports expected runtime evidence. Avoid: smoke test when real deployment evidence is meant.

**Conversation Snapshot**: Saved generated files and project memory scoped to a user conversation. Avoid: chat history when referring to generated artifact state.

**Application Market**: The local catalog of generated apps that can be published, previewed, listed, and deployed back to a board. Avoid: route handler, market table, gallery when referring to the workflow.

**Digital Life Companion**: The standalone local companion experience with persistent state, long-term memory, rewards, cognition, speech, and presence. Avoid: chatbot, widget.

**Companion Memory**: Long-lived facts or persona seeds the Digital Life Companion should consider before replying. Avoid: log, cache.

**Cognition Cycle**: The Digital Life Companion's observe, abstract, hypothesize, test, update loop. Avoid: summary, reflection when specifically referring to hypothesis formation.

**Hardware Adapter**: A concrete integration that maps local server behavior to board, audio, speech, or presence capabilities. Avoid: mock if the role is the boundary rather than the implementation.
