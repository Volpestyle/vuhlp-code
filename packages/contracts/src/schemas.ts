export const eventEnvelopeSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "EventEnvelope",
  type: "object",
  required: ["id", "runId", "ts", "type"],
  properties: {
    id: { type: "string" },
    runId: { type: "string" },
    ts: { type: "string", format: "date-time" },
    type: { type: "string" },
    nodeId: { type: "string" }
  },
  additionalProperties: true
} as const;

export const usageTotalsSchema = {
  type: "object",
  required: ["promptTokens", "completionTokens", "totalTokens"],
  properties: {
    promptTokens: { type: "number" },
    completionTokens: { type: "number" },
    totalTokens: { type: "number" }
  }
} as const;

export const nodeStateSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "NodeState",
  type: "object",
  required: [
    "id",
    "runId",
    "label",
    "roleTemplate",
    "provider",
    "status",
    "summary",
    "lastActivityAt",
    "capabilities",
    "permissions",
    "session"
  ],
  properties: {
    id: { type: "string" },
    runId: { type: "string" },
    label: { type: "string" },
    alias: { type: "string" },
    roleTemplate: { type: "string" },
    customSystemPrompt: { type: ["string", "null"] },
    provider: { type: "string" },
    status: { type: "string" },
    summary: { type: "string" },
    lastActivityAt: { type: "string", format: "date-time" },
    usage: usageTotalsSchema,
    capabilities: {
      type: "object",
      required: ["edgeManagement", "writeCode", "writeDocs", "runCommands", "delegateOnly"],
      properties: {
        edgeManagement: { type: "string", enum: ["none", "self", "all"] },
        writeCode: { type: "boolean" },
        writeDocs: { type: "boolean" },
        runCommands: { type: "boolean" },
        delegateOnly: { type: "boolean" }
      }
    },
    permissions: {
      type: "object",
      required: ["cliPermissionsMode", "agentManagementRequiresApproval"],
      properties: {
        cliPermissionsMode: { type: "string", enum: ["skip", "gated"] },
        agentManagementRequiresApproval: { type: "boolean" }
      }
    },
    session: {
      type: "object",
      required: ["sessionId", "resetCommands"],
      properties: {
        sessionId: { type: "string" },
        resetCommands: { type: "array", items: { type: "string" } }
      }
    },
    connection: {
      type: "object",
      required: ["status", "streaming", "lastHeartbeatAt", "lastOutputAt"],
      properties: {
        status: { type: "string", enum: ["connected", "idle", "disconnected"] },
        streaming: { type: "boolean" },
        lastHeartbeatAt: { type: "string", format: "date-time" },
        lastOutputAt: { type: "string", format: "date-time" }
      }
    },
    inboxCount: { type: "number" }
  },
  additionalProperties: true
} as const;

export const nodeConfigSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "NodeConfig",
  type: "object",
  required: ["label", "provider", "roleTemplate", "capabilities", "permissions", "session"],
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    alias: { type: "string" },
    provider: { type: "string" },
    roleTemplate: { type: "string" },
    customSystemPrompt: { type: ["string", "null"] },
    capabilities: {
      type: "object",
      required: ["edgeManagement", "writeCode", "writeDocs", "runCommands", "delegateOnly"],
      properties: {
        edgeManagement: { type: "string", enum: ["none", "self", "all"] },
        writeCode: { type: "boolean" },
        writeDocs: { type: "boolean" },
        runCommands: { type: "boolean" },
        delegateOnly: { type: "boolean" }
      }
    },
    permissions: {
      type: "object",
      required: ["cliPermissionsMode", "agentManagementRequiresApproval"],
      properties: {
        cliPermissionsMode: { type: "string", enum: ["skip", "gated"] },
        agentManagementRequiresApproval: { type: "boolean" }
      }
    },
    session: {
      type: "object",
      required: ["resume", "resetCommands"],
      properties: {
        resume: { type: "boolean" },
        resetCommands: { type: "array", items: { type: "string" } }
      }
    }
  },
  additionalProperties: true
} as const;

export const edgeStateSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "EdgeState",
  type: "object",
  required: ["id", "from", "to", "bidirectional", "type", "label"],
  properties: {
    id: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    bidirectional: { type: "boolean" },
    type: { type: "string", enum: ["handoff", "report"] },
    label: { type: "string" }
  }
} as const;

export const artifactSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "Artifact",
  type: "object",
  required: ["id", "runId", "nodeId", "kind", "name", "path", "createdAt"],
  properties: {
    id: { type: "string" },
    runId: { type: "string" },
    nodeId: { type: "string" },
    kind: { type: "string" },
    name: { type: "string" },
    path: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
    metadata: {
      type: "object",
      properties: {
        filesChanged: { type: "array", items: { type: "string" } },
        summary: { type: "string" }
      }
    }
  }
} as const;

export const runStateSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "RunState",
  type: "object",
  required: [
    "id",
    "contractVersion",
    "status",
    "mode",
    "globalMode",
    "createdAt",
    "updatedAt",
    "nodes",
    "edges",
    "artifacts"
  ],
  properties: {
    id: { type: "string" },
    contractVersion: { type: "string", enum: ["1"] },
    status: { type: "string", enum: ["queued", "running", "paused", "stopped", "completed", "failed"] },
    mode: { type: "string", enum: ["AUTO", "INTERACTIVE"] },
    globalMode: { type: "string", enum: ["PLANNING", "IMPLEMENTATION"] },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
    usage: usageTotalsSchema,
    nodes: { type: "object", additionalProperties: nodeStateSchema },
    nodeConfigs: { type: "object", additionalProperties: nodeConfigSchema },
    edges: { type: "object", additionalProperties: edgeStateSchema },
    artifacts: { type: "object", additionalProperties: artifactSchema },
    layout: {
      type: "object",
      required: ["positions", "viewport", "updatedAt"],
      properties: {
        positions: {
          type: "object",
          additionalProperties: {
            type: "object",
            required: ["x", "y"],
            properties: {
              x: { type: "number" },
              y: { type: "number" }
            }
          }
        },
        viewport: {
          type: "object",
          required: ["x", "y", "zoom"],
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            zoom: { type: "number" }
          }
        },
        updatedAt: { type: "string", format: "date-time" }
      }
    }
  }
} as const;

export const envelopeSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "Envelope",
  type: "object",
  required: ["kind", "id", "fromNodeId", "toNodeId", "createdAt", "payload"],
  properties: {
    kind: { type: "string", enum: ["handoff", "signal"] },
    id: { type: "string" },
    fromNodeId: { type: "string" },
    toNodeId: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
    payload: {
      type: "object",
      required: ["message"],
      properties: {
        message: { type: "string" },
        structured: { type: "object" },
        artifacts: {
          type: "array",
          items: {
            type: "object",
            required: ["type", "ref"],
            properties: {
              type: { type: "string" },
              ref: { type: "string" }
            }
          }
        },
        status: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            reason: { type: "string" }
          }
        },
        response: {
          type: "object",
          properties: {
            expectation: { type: "string", enum: ["none", "optional", "required"] },
            replyTo: { type: "string" }
          },
          required: ["expectation"]
        }
      }
    },
    contextRef: { type: "string" },
    meta: { type: "object" }
  }
} as const;
