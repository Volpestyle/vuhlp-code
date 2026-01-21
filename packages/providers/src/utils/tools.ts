/**
 * Canonical tool definitions with provider-specific transformers.
 * Single source of truth - no more duplicated tool schemas.
 */

// ============================================================================
// Types
// ============================================================================

interface JsonSchemaProperty {
    type: string;
    description?: string;
    enum?: string[];
    items?: JsonSchemaProperty | { type: string; properties?: Record<string, JsonSchemaProperty>; required?: string[] };
    properties?: Record<string, JsonSchemaProperty>;
    required?: string[];
}

interface JsonSchema {
    type: "object";
    properties: Record<string, JsonSchemaProperty>;
    required?: string[];
}

export type VuhlpToolName =
    | "command"
    | "read_file"
    | "write_file"
    | "list_files"
    | "delete_file"
    | "spawn_node"
    | "create_edge"
    | "send_handoff";

export type ToolKind = "workspace" | "vuhlp-only";

interface CanonicalTool {
    name: VuhlpToolName;
    description: string;
    parameters: JsonSchema;
    kind: ToolKind;
    protocolSchema: string;
}

// Provider-specific output types
interface OpenAITool {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: JsonSchema;
    };
}

interface ClaudeTool {
    name: string;
    description: string;
    input_schema: JsonSchema;
}

interface GeminiTool {
    name: string;
    description: string;
    parameters: JsonSchema;
}

// ============================================================================
// Canonical Tool Definitions (Single Source of Truth)
// ============================================================================

const TOOL_REGISTRY: ReadonlyArray<CanonicalTool> = [
    {
        name: "command",
        description: "Run a shell command in the repository.",
        kind: "workspace",
        protocolSchema: "command: { cmd: string, cwd?: string }",
        parameters: {
            type: "object",
            properties: {
                cmd: { type: "string", description: "Shell command to run." },
                cwd: { type: "string", description: "Optional working directory." }
            },
            required: ["cmd"]
        }
    },
    {
        name: "read_file",
        description: "Read a file from the repository.",
        kind: "workspace",
        protocolSchema: "read_file: { path: string }",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "Path relative to repo root." }
            },
            required: ["path"]
        }
    },
    {
        name: "write_file",
        description: "Write a file in the repository.",
        kind: "workspace",
        protocolSchema: "write_file: { path: string, content: string }",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "Path relative to repo root." },
                content: { type: "string", description: "File contents." }
            },
            required: ["path", "content"]
        }
    },
    {
        name: "list_files",
        description: "List files in a directory.",
        kind: "workspace",
        protocolSchema: "list_files: { path?: string }",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "Directory path relative to repo root." }
            }
        }
    },
    {
        name: "delete_file",
        description: "Delete a file from the repository.",
        kind: "workspace",
        protocolSchema: "delete_file: { path: string }",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "Path relative to repo root." }
            },
            required: ["path"]
        }
    },
    {
        name: "spawn_node",
        description: "Create a new node in the current run for delegation.",
        kind: "vuhlp-only",
        protocolSchema:
            "spawn_node: { label: string, alias?: string, roleTemplate: string, instructions?: string, input?: object, provider?: string, capabilities?: object, permissions?: object, session?: object, customSystemPrompt?: string }",
        parameters: {
            type: "object",
            properties: {
                label: { type: "string", description: "Node display label." },
                alias: { type: "string", description: "Optional stable alias for the node." },
                roleTemplate: { type: "string", description: "Role template name for the new node." },
                role: { type: "string", description: "Alias for roleTemplate." },
                provider: { type: "string", description: "Provider to use for the new node." },
                customSystemPrompt: { type: "string", description: "Optional custom system prompt override." },
                capabilities: {
                    type: "object",
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
                    properties: {
                        cliPermissionsMode: { type: "string" },
                        agentManagementRequiresApproval: { type: "boolean" }
                    }
                },
                session: {
                    type: "object",
                    properties: {
                        resume: { type: "boolean" },
                        resetCommands: { type: "array", items: { type: "string" } }
                    }
                },
                instructions: { type: "string", description: "Initial task instructions for the node." },
                input: { type: "object", description: "Structured input payload for the node." }
            },
            required: ["label", "roleTemplate"]
        }
    },
    {
        name: "create_edge",
        description: "Create an edge between two nodes in the current run.",
        kind: "vuhlp-only",
        protocolSchema:
            'create_edge: { from: string, to: string, bidirectional?: boolean, type?: "handoff" | "report", label?: string } (from/to = node id or alias)',
        parameters: {
            type: "object",
            properties: {
                from: { type: "string", description: "Source node id or alias." },
                to: { type: "string", description: "Target node id or alias." },
                bidirectional: { type: "boolean", description: "Whether the edge is bidirectional." },
                type: { type: "string", description: "Edge type (handoff or report)." },
                label: { type: "string", description: "Edge label." }
            },
            required: ["from", "to"]
        }
    },
    {
        name: "send_handoff",
        description: "Send a handoff envelope to another node.",
        kind: "vuhlp-only",
        protocolSchema:
            'send_handoff: { to: string, message: string, structured?: object, artifacts?: [{type: string, ref: string}], status?: {ok: boolean, reason?: string}, response?: {expectation: "none" | "optional" | "required", replyTo?: string}, contextRef?: string } (to/replyTo = node id or alias)',
        parameters: {
            type: "object",
            properties: {
                to: { type: "string", description: "Target node id or alias." },
                message: { type: "string", description: "Summary message for the handoff." },
                structured: { type: "object", description: "Structured JSON payload." },
                artifacts: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            type: { type: "string" },
                            ref: { type: "string" }
                        },
                        required: ["type", "ref"]
                    }
                },
                status: {
                    type: "object",
                    properties: {
                        ok: { type: "boolean" },
                        reason: { type: "string" }
                    },
                    required: ["ok"]
                },
                response: {
                    type: "object",
                    properties: {
                        expectation: { type: "string", enum: ["none", "optional", "required"] },
                        replyTo: { type: "string", description: "Node id or alias to reply to." }
                    },
                    required: ["expectation"]
                },
                contextRef: { type: "string", description: "Context pack reference." }
            },
            required: ["to", "message"]
        }
    }
];

const TOOL_NAMES: ReadonlyArray<VuhlpToolName> = TOOL_REGISTRY.map((tool) => tool.name);
const VUHLP_ONLY_TOOL_NAMES: ReadonlyArray<VuhlpToolName> = TOOL_REGISTRY
    .filter((tool) => tool.kind === "vuhlp-only")
    .map((tool) => tool.name);
const PROVIDER_NATIVE_TOOL_NAMES: ReadonlyArray<VuhlpToolName> = TOOL_REGISTRY
    .filter((tool) => tool.kind === "workspace")
    .map((tool) => tool.name);

// ============================================================================
// Provider Transformers
// ============================================================================

function toOpenAI(tool: CanonicalTool): OpenAITool {
    return {
        type: "function",
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
        }
    };
}

function toClaude(tool: CanonicalTool): ClaudeTool {
    return {
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters
    };
}

function toGemini(tool: CanonicalTool): GeminiTool {
    return {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
    };
}

// ============================================================================
// Exported Functions (Backward Compatible API)
// ============================================================================

export function openAiToolDefinitions(): OpenAITool[] {
    return TOOL_REGISTRY.map(toOpenAI);
}

export function claudeToolDefinitions(): ClaudeTool[] {
    return TOOL_REGISTRY.map(toClaude);
}

export function geminiToolDefinitions(): GeminiTool[] {
    return TOOL_REGISTRY.map(toGemini);
}

export function getToolRegistry(): ReadonlyArray<CanonicalTool> {
    return TOOL_REGISTRY;
}

export function getVuhlpToolNames(): ReadonlyArray<VuhlpToolName> {
    return TOOL_NAMES;
}

export function getVuhlpOnlyToolNames(): ReadonlyArray<VuhlpToolName> {
    return VUHLP_ONLY_TOOL_NAMES;
}

export function getProviderNativeToolNames(): ReadonlyArray<VuhlpToolName> {
    return PROVIDER_NATIVE_TOOL_NAMES;
}

// Export canonical tools for direct access if needed
export { TOOL_REGISTRY as canonicalTools };
export type { CanonicalTool, OpenAITool, ClaudeTool, GeminiTool };
