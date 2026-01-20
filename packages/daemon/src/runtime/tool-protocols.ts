/**
 * Tool protocol instructions for CLI providers
 *
 * These are injected into prompts to guide the model on how to
 * emit tool calls for vuhlp to process.
 */

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
  "command: { cmd: string, cwd?: string }",
  "read_file: { path: string }",
  "write_file: { path: string, content: string }",
  "list_files: { path?: string }",
  "delete_file: { path: string }",
  'spawn_node: { label: string, alias?: string, roleTemplate: string, instructions?: string, input?: object, provider?: string, capabilities?: object, permissions?: object, session?: object, customSystemPrompt?: string }',
  'create_edge: { from: string, to: string, bidirectional?: boolean, type?: "handoff" | "report", label?: string } (from/to = node id or alias)',
  'send_handoff: { to: string, message: string, structured?: object, artifacts?: [{type: string, ref: string}], status?: {ok: boolean, reason?: string}, response?: {expectation: "none" | "optional" | "required", replyTo?: string}, contextRef?: string } (to/replyTo = node id or alias)',
  "Examples (emit exactly as a single line when calling):",
  '{"tool_call":{"id":"<uuid>","name":"spawn_node","args":{"label":"Docs Agent","alias":"docs-agent","roleTemplate":"planner","instructions":"Summarize docs/.","provider":"claude"}}}',
  '{"tool_call":{"id":"<uuid>","name":"create_edge","args":{"from":"<node-id-or-alias>","to":"<node-id-or-alias>","type":"handoff","bidirectional":true,"label":"docs"}}}',
  '{"tool_call":{"id":"<uuid>","name":"send_handoff","args":{"to":"<node-id-or-alias>","message":"Status update"}}}',
  "Available vuhlp tools: command, read_file, write_file, list_files, delete_file, spawn_node, create_edge, send_handoff.",
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
  "Use tool_call JSON only when you need vuhlp tools (spawn_node, create_edge, send_handoff, command, read_file, write_file, list_files, delete_file).",
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
  "command: { cmd: string, cwd?: string }",
  "read_file: { path: string }",
  "write_file: { path: string, content: string }",
  "list_files: { path?: string }",
  "delete_file: { path: string }",
  'spawn_node: { label: string, alias?: string, roleTemplate: string, instructions?: string, input?: object, provider?: string, capabilities?: object, permissions?: object, session?: object, customSystemPrompt?: string }',
  'create_edge: { from: string, to: string, bidirectional?: boolean, type?: "handoff" | "report", label?: string } (from/to = node id or alias)',
  'send_handoff: { to: string, message: string, structured?: object, artifacts?: [{type: string, ref: string}], status?: {ok: boolean, reason?: string}, response?: {expectation: "none" | "optional" | "required", replyTo?: string}, contextRef?: string } (to/replyTo = node id or alias)',
  "Examples (emit exactly as a single line when calling):",
  '{"tool_call":{"id":"<uuid>","name":"spawn_node","args":{"label":"Docs Agent","alias":"docs-agent","roleTemplate":"planner","instructions":"Summarize docs/.","provider":"claude"}}}',
  '{"tool_call":{"id":"<uuid>","name":"create_edge","args":{"from":"<node-id-or-alias>","to":"<node-id-or-alias>","type":"handoff","bidirectional":true,"label":"docs"}}}',
  '{"tool_call":{"id":"<uuid>","name":"send_handoff","args":{"to":"<node-id-or-alias>","message":"Status update"}}}',
  "Available vuhlp tools: command, read_file, write_file, list_files, delete_file, spawn_node, create_edge, send_handoff.",
  "Outgoing handoffs are explicit; use send_handoff to communicate between nodes.",
  "create_edge only connects nodes; it does not deliver messages.",
  "send_handoff requires to + message and an existing edge between nodes; optional structured, artifacts, status, response, contextRef."
].join("\n");
