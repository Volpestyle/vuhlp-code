
export function openAiToolDefinitions() {
    return [
        {
            type: "function",
            function: {
                name: "command",
                description: "Run a shell command in the repository.",
                parameters: {
                    type: "object",
                    properties: {
                        cmd: { type: "string", description: "Shell command to run." },
                        cwd: { type: "string", description: "Optional working directory." }
                    },
                    required: ["cmd"]
                }
            }
        },
        {
            type: "function",
            function: {
                name: "read_file",
                description: "Read a file from the repository.",
                parameters: {
                    type: "object",
                    properties: {
                        path: { type: "string", description: "Path relative to repo root." }
                    },
                    required: ["path"]
                }
            }
        },
        {
            type: "function",
            function: {
                name: "write_file",
                description: "Write a file in the repository.",
                parameters: {
                    type: "object",
                    properties: {
                        path: { type: "string", description: "Path relative to repo root." },
                        content: { type: "string", description: "File contents." }
                    },
                    required: ["path", "content"]
                }
            }
        },
        {
            type: "function",
            function: {
                name: "list_files",
                description: "List files in a directory.",
                parameters: {
                    type: "object",
                    properties: {
                        path: { type: "string", description: "Directory path relative to repo root." }
                    }
                }
            }
        },
        {
            type: "function",
            function: {
                name: "delete_file",
                description: "Delete a file from the repository.",
                parameters: {
                    type: "object",
                    properties: {
                        path: { type: "string", description: "Path relative to repo root." }
                    },
                    required: ["path"]
                }
            }
        },
        {
            type: "function",
            function: {
                name: "spawn_node",
                description: "Create a new node in the current run for delegation.",
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
            }
        },
        {
            type: "function",
            function: {
                name: "create_edge",
                description: "Create an edge between two nodes in the current run.",
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
            }
        },
        {
            type: "function",
            function: {
                name: "send_handoff",
                description: "Send a handoff envelope to another node.",
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
        }
    ];
}

export function claudeToolDefinitions() {
    return [
        {
            name: "command",
            description: "Run a shell command in the repository.",
            input_schema: {
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
            input_schema: {
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
            input_schema: {
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
            input_schema: {
                type: "object",
                properties: {
                    path: { type: "string", description: "Directory path relative to repo root." }
                }
            }
        },
        {
            name: "delete_file",
            description: "Delete a file from the repository.",
            input_schema: {
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
            input_schema: {
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
            input_schema: {
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
            input_schema: {
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
}

export function geminiToolDefinitions() {
    return [
        {
            name: "command",
            description: "Run a shell command in the repository.",
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
}
