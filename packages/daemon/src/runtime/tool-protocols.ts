/**
 * Tool protocol instructions for CLI providers
 *
 * These are injected into prompts to guide the model on how to
 * emit tool calls for vuhlp to process.
 */

import {
  getToolRegistry,
  getVuhlpOnlyToolNames,
  getVuhlpToolNames,
  type VuhlpToolName
} from "@vuhlp/providers";

function formatToolNames(names: ReadonlyArray<VuhlpToolName>): string {
  return names.join(", ");
}

const TOOL_REGISTRY = getToolRegistry();
const TOOL_SCHEMA_LINES = TOOL_REGISTRY.map((tool) => tool.protocolSchema);
const VUHLP_ONLY_TOOL_SCHEMA_LINES = TOOL_REGISTRY
  .filter((tool) => tool.kind === "vuhlp-only")
  .map((tool) => tool.protocolSchema);

/**
 * Tool protocol for vuhlp-handled tools
 * Used when nativeToolHandling is 'vuhlp'
 */
export const CLI_TOOL_PROTOCOL_VUHLP = [
  "Tool calls:",
  "Use native tool calling when available (Claude CLI: Task for spawning, Bash for shell commands).",
  "vuhlp maps native tools to vuhlp tools (Task -> spawn_node, Bash -> command).",
  "If a tool is not available natively, emit a single-line JSON object in your response:",
  '{"tool_call":{"id":"tool-1","name":"<tool>","args":{...}}}',
  "Do not wrap the JSON in markdown. One tool call per line.",
  "Tool_call JSON must be the entire line with no extra text.",
  "Use args (not params) for tool_call JSON.",
  "Tool_call id can be any short unique string or omitted (vuhlp will generate one). Do not call Bash to generate ids.",
  "Do not use Bash to emit tool_call JSON or simulate tool calls.",
  "Bash output containing tool_call JSON is treated as an error.",
  "Only use spawn_node when Task Payload shows edgeManagement=all.",
  "Only use create_edge when Task Payload shows edgeManagement=all or edgeManagement=self (self must be one endpoint).",
  "Use spawn_node alias to reference freshly spawned nodes in the same response.",
  "Aliases must be unique within the run.",
  "Tool schemas (tool_call args):",
  ...TOOL_SCHEMA_LINES,
  "Examples (emit exactly as a single line when calling):",
  '{"tool_call":{"id":"<uuid>","name":"spawn_node","args":{"label":"Docs Agent","alias":"docs-agent","roleTemplate":"planner","instructions":"Summarize docs/.","provider":"claude"}}}',
  '{"tool_call":{"id":"<uuid>","name":"create_edge","args":{"from":"<node-id-or-alias>","to":"<node-id-or-alias>","type":"handoff","bidirectional":true,"label":"docs"}}}',
  '{"tool_call":{"id":"<uuid>","name":"send_handoff","args":{"to":"<node-id-or-alias>","message":"Status update"}}}',
  `Available vuhlp tools: ${formatToolNames(getVuhlpToolNames())}.`,
  "Outgoing handoffs are explicit; use send_handoff to communicate between nodes.",
  "create_edge only connects nodes; it does not deliver messages.",
  "send_handoff requires to + message and an existing edge between nodes; optional structured, artifacts, status, response, contextRef."
].join("\n");

/**
 * Tool protocol for provider-native tool handling
 * Used when nativeToolHandling is 'provider'
 */
export const CLI_TOOL_PROTOCOL_PROVIDER_NATIVE = [
  "Tool calls:",
  "Use native tool calling for provider-native tools. The CLI executes those tools directly; vuhlp will not rerun them.",
  "Use tool_call JSON only for vuhlp-only tools (spawn_node, create_edge, send_handoff).",
  "Do not emit tool_call JSON for file or command tools in provider-native mode; use provider-native tools instead.",
  '{"tool_call":{"id":"tool-1","name":"<tool>","args":{...}}}',
  "Do not wrap the JSON in markdown. One tool call per line.",
  "Tool_call JSON must be the entire line with no extra text.",
  "Use args (not params) for tool_call JSON.",
  "Tool_call id can be any short unique string or omitted (vuhlp will generate one). Do not call Bash to generate ids.",
  "Do not use Bash to emit tool_call JSON or simulate tool calls.",
  "Bash output containing tool_call JSON is treated as an error.",
  "Only use spawn_node when Task Payload shows edgeManagement=all.",
  "Only use create_edge when Task Payload shows edgeManagement=all or edgeManagement=self (self must be one endpoint).",
  "Use spawn_node alias to reference freshly spawned nodes in the same response.",
  "Aliases must be unique within the run.",
  "Tool schemas (tool_call args):",
  ...VUHLP_ONLY_TOOL_SCHEMA_LINES,
  "Examples (emit exactly as a single line when calling):",
  '{"tool_call":{"id":"<uuid>","name":"spawn_node","args":{"label":"Docs Agent","alias":"docs-agent","roleTemplate":"planner","instructions":"Summarize docs/.","provider":"claude"}}}',
  '{"tool_call":{"id":"<uuid>","name":"create_edge","args":{"from":"<node-id-or-alias>","to":"<node-id-or-alias>","type":"handoff","bidirectional":true,"label":"docs"}}}',
  '{"tool_call":{"id":"<uuid>","name":"send_handoff","args":{"to":"<node-id-or-alias>","message":"Status update"}}}',
  `Available vuhlp tools in provider-native mode: ${formatToolNames(getVuhlpOnlyToolNames())}.`,
  "Outgoing handoffs are explicit; use send_handoff to communicate between nodes.",
  "create_edge only connects nodes; it does not deliver messages.",
  "send_handoff requires to + message and an existing edge between nodes; optional structured, artifacts, status, response, contextRef."
].join("\n");
