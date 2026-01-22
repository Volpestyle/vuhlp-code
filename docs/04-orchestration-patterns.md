# Orchestration patterns

v0 supports graph-based orchestration with explicit nodes and edges. The scheduler runs nodes when they are idle and have inputs.

## 1. Single node

Use a single node for direct chat with a provider. The node runs when it has queued inputs.

## 2. Linear chain

Connect nodes with `handoff` edges. When Node A completes, it can call `send_handoff` to queue Node B.

Example:

```
Research -> Implement -> Review
```

## 3. Feedback loop

Use a bidirectional edge between two nodes. Each completion can send a handoff to the other node.

## 4. Orchestrator fan-out

The orchestrator can spawn new agents/nodes via tool_call JSON:

```json
{"tool_call":{"id":"spawn-1","name":"spawn_node","args":{"roleTemplate":"implementer","label":"Frontend Builder","instructions":"Build UI components"}}}
```

Then connect and dispatch handoffs using `create_edge` + `send_handoff`.
