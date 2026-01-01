import path from "node:path";
import { stat, mkdir, writeFile } from "node:fs/promises";
import type { ModelRecord } from "@volpestyle/ai-kit-node";
import type { Config, ModelPolicy } from "../config";
import { Store } from "../runstore";
import { errorResponse, jsonResponse } from "../util/json";
import { defaultSpecPath, ensureSpecFile } from "../util/spec";
import { handleDashboard } from "./dashboard";
import { applyMiddleware, authMiddleware, corsMiddleware, loggingMiddleware, recoverMiddleware, Handler } from "./middleware";
import type {
  AddMessageRequest,
  AddMessageResponse,
  ApproveRequest,
  AttachmentUploadRequest,
  AttachmentUploadResponse,
  CreateRunRequest,
  CreateRunResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  GenerateSpecRequest,
  GenerateSpecResponse,
  SessionApproveRequest,
  UpdateSessionModeRequest,
  UpdateSessionModeResponse,
} from "./types";
import { newMessageId } from "../util/id";

export interface RunStarter {
  startRun(runId: string): Promise<void>;
}

export interface SessionTurnStarter {
  startTurn(sessionId: string, turnId: string): Promise<void>;
}

export interface SpecGenerator {
  generateSpec(workspacePath: string, specName: string, prompt: string): Promise<string>;
}

export interface ModelService {
  listModels(): Promise<ModelRecord[]>;
  getPolicy(): ModelPolicy;
  setPolicy(policy: ModelPolicy): Promise<void>;
}

export class Server {
  constructor(
    private store: Store,
    private authToken: string,
    private runner?: RunStarter,
    private sessionRunner?: SessionTurnStarter,
    private specGen?: SpecGenerator,
    private modelSvc?: ModelService,
  ) {}

  handler(): Handler {
    const handler: Handler = async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/" || !url.pathname.startsWith("/v1/")) {
        return handleDashboard(req);
      }
      if (url.pathname === "/healthz") {
        return jsonResponse({ ok: true });
      }
      if (url.pathname === "/hello") {
        return jsonResponse({ message: "hello" });
      }
      if (url.pathname === "/v1/runs") {
        return this.handleRuns(req);
      }
      if (url.pathname.startsWith("/v1/runs/")) {
        return this.handleRun(req);
      }
      if (url.pathname === "/v1/sessions") {
        return this.handleSessions(req);
      }
      if (url.pathname.startsWith("/v1/sessions/")) {
        return this.handleSession(req);
      }
      if (url.pathname === "/v1/specs/generate") {
        return this.handleSpecGenerate(req);
      }
      if (url.pathname === "/v1/models") {
        return this.handleModels(req);
      }
      if (url.pathname === "/v1/model-policy") {
        return this.handleModelPolicy(req);
      }
      if (url.pathname === "/v1/workspace/tree") {
        return this.handleWorkspaceTree(req);
      }
      return new Response("not found", { status: 404 });
    };

    return applyMiddleware(handler, [
      recoverMiddleware(),
      loggingMiddleware(),
      authMiddleware(this.authToken),
      corsMiddleware(),
    ]);
  }

  private async parseJSON<T>(req: Request): Promise<T> {
    const text = await req.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error("invalid json");
    }
  }

  private async handleRuns(req: Request): Promise<Response> {
    if (req.method === "GET") {
      const runs = await this.store.listRuns();
      return jsonResponse(runs);
    }
    if (req.method === "POST") {
      let body: CreateRunRequest;
      try {
        body = await this.parseJSON<CreateRunRequest>(req);
      } catch {
        return errorResponse("invalid json", 400);
      }
      try {
        const run = await this.store.createRun(body.workspace_path, body.spec_path);
        if (this.runner) {
          await this.runner.startRun(run.id);
        }
        const resp: CreateRunResponse = { run_id: run.id };
        return jsonResponse(resp);
      } catch (err: unknown) {
        return errorResponse((err as Error).message, 400);
      }
    }
    return new Response(null, { status: 405 });
  }

  private async handleRun(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const rest = url.pathname.replace("/v1/runs/", "");
    const parts = rest.split("/");
    const runId = parts[0];
    if (!runId) return errorResponse("run id required", 404);

    if (parts.length === 1 || !parts[1]) {
      if (req.method !== "GET") return new Response(null, { status: 405 });
      try {
        const run = await this.store.getRun(runId);
        return jsonResponse(run);
      } catch (err: unknown) {
        return errorResponse((err as Error).message, 404);
      }
    }

    switch (parts[1]) {
      case "events":
        if (req.method !== "GET") return new Response(null, { status: 405 });
        return this.handleRunEvents(req, runId);
      case "approve":
        if (req.method !== "POST") return new Response(null, { status: 405 });
        try {
          const body = await this.parseJSON<ApproveRequest>(req);
          if (!body.step_id) return errorResponse("step_id required", 400);
          await this.store.approve(runId, body.step_id);
          await this.store.appendEvent(runId, {
            ts: new Date().toISOString(),
            run_id: runId,
            type: "approval_granted",
            data: { step_id: body.step_id },
          });
          return jsonResponse({ ok: true });
        } catch (err: unknown) {
          return errorResponse((err as Error).message, 400);
        }
      case "cancel":
        if (req.method !== "POST") return new Response(null, { status: 405 });
        this.store.cancelRun(runId);
        await this.store.appendEvent(runId, {
          ts: new Date().toISOString(),
          run_id: runId,
          type: "run_cancel_requested",
        });
        return jsonResponse({ ok: true });
      case "export":
        if (req.method !== "GET") return new Response(null, { status: 405 });
        try {
          const zip = await this.store.exportRun(runId);
          return new Response(zip, {
            headers: {
              "Content-Type": "application/zip",
              "Content-Disposition": `attachment; filename=\"${runId}.zip\"`,
            },
          });
        } catch (err: unknown) {
          return errorResponse((err as Error).message, 500);
        }
      default:
        return errorResponse("unknown endpoint", 404);
    }
  }

  private async handleSessions(req: Request): Promise<Response> {
    if (req.method === "GET") {
      const sessions = await this.store.listSessions();
      return jsonResponse(sessions);
    }
    if (req.method === "POST") {
      let body: CreateSessionRequest;
      try {
        body = await this.parseJSON<CreateSessionRequest>(req);
      } catch {
        return errorResponse("invalid json", 400);
      }
      const mode = body.mode?.trim() || "chat";
      let specPath = body.spec_path?.trim() || "";
      if (specPath) {
        try {
          specPath = await resolveSpecPath(body.workspace_path, specPath);
        } catch (err: unknown) {
          return errorResponse((err as Error).message, 400);
        }
      }
      try {
        const session = await this.store.createSession(
          body.workspace_path,
          body.system_prompt ?? "",
          mode,
          specPath,
        );
        if (session.mode === "spec" && !session.spec_path?.trim()) {
          const defaultPath = await defaultSpecPath(session.workspace_path, `session-${session.id}`);
          session.spec_path = defaultPath;
          await this.store.updateSession(session);
          await this.store.appendSessionEvent(session.id, {
            ts: new Date().toISOString(),
            session_id: session.id,
            type: "spec_path_set",
            data: { spec_path: session.spec_path },
          });
          const created = await ensureSpecFile(session.spec_path);
          if (created) {
            await this.store.appendSessionEvent(session.id, {
              ts: new Date().toISOString(),
              session_id: session.id,
              type: "spec_created",
              data: { spec_path: session.spec_path },
            });
          }
        }
        const resp: CreateSessionResponse = {
          session_id: session.id,
          spec_path: session.spec_path,
        };
        return jsonResponse(resp);
      } catch (err: unknown) {
        return errorResponse((err as Error).message, 400);
      }
    }
    return new Response(null, { status: 405 });
  }

  private async handleSession(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const rest = url.pathname.replace("/v1/sessions/", "");
    const parts = rest.split("/");
    const sessionId = parts[0];
    if (!sessionId) return errorResponse("session id required", 404);

    if (parts.length === 1 || !parts[1]) {
      if (req.method !== "GET") return new Response(null, { status: 405 });
      try {
        const session = await this.store.getSession(sessionId);
        return jsonResponse(session);
      } catch (err: unknown) {
        return errorResponse((err as Error).message, 404);
      }
    }

    switch (parts[1]) {
      case "mode":
        if (req.method !== "POST") return new Response(null, { status: 405 });
        return this.handleSessionMode(req, sessionId);
      case "events":
        if (req.method !== "GET") return new Response(null, { status: 405 });
        return this.handleSessionEvents(req, sessionId);
      case "messages":
        if (req.method !== "POST") return new Response(null, { status: 405 });
        return this.handleSessionMessage(req, sessionId);
      case "approve":
        if (req.method !== "POST") return new Response(null, { status: 405 });
        return this.handleSessionApprove(req, sessionId);
      case "cancel":
        if (req.method !== "POST") return new Response(null, { status: 405 });
        await this.store.cancelSession(sessionId);
        await this.store.appendSessionEvent(sessionId, {
          ts: new Date().toISOString(),
          session_id: sessionId,
          type: "session_canceled",
        });
        return jsonResponse({ ok: true });
      case "attachments":
        if (req.method !== "POST") return new Response(null, { status: 405 });
        return this.handleSessionAttachment(req, sessionId);
      case "turns":
        if (parts.length >= 4 && parts[3] === "retry") {
          if (req.method !== "POST") return new Response(null, { status: 405 });
          if (!this.sessionRunner) return errorResponse("session runner not configured", 500);
          const turnId = parts[2];
          await this.sessionRunner.startTurn(sessionId, turnId);
          return jsonResponse({ ok: true });
        }
        return errorResponse("unknown endpoint", 404);
      default:
        return errorResponse("unknown endpoint", 404);
    }
  }

  private async handleSessionMode(req: Request, sessionId: string): Promise<Response> {
    let body: UpdateSessionModeRequest;
    try {
      body = await this.parseJSON<UpdateSessionModeRequest>(req);
    } catch {
      return errorResponse("invalid json", 400);
    }
    if (!body.mode?.trim()) return errorResponse("mode is required", 400);
    if (body.mode !== "chat" && body.mode !== "spec") {
      return errorResponse("mode must be chat or spec", 400);
    }
    let session: Awaited<ReturnType<Store["getSession"]>>;
    try {
      session = await this.store.getSession(sessionId);
    } catch (err: unknown) {
      return errorResponse((err as Error).message, 404);
    }
    let specPath = body.spec_path?.trim() || "";
    if (body.mode === "spec") {
      if (specPath) {
        try {
          specPath = await resolveSpecPath(session.workspace_path, specPath);
        } catch (err: unknown) {
          return errorResponse((err as Error).message, 400);
        }
      } else if (!session.spec_path?.trim()) {
        specPath = await defaultSpecPath(session.workspace_path, `session-${session.id}`);
      } else {
        specPath = session.spec_path;
      }
    } else if (specPath) {
      try {
        specPath = await resolveSpecPath(session.workspace_path, specPath);
      } catch (err: unknown) {
        return errorResponse((err as Error).message, 400);
      }
    }

    session.mode = body.mode;
    if (specPath.trim()) session.spec_path = specPath;
    await this.store.updateSession(session);
    await this.store.appendSessionEvent(sessionId, {
      ts: new Date().toISOString(),
      session_id: sessionId,
      type: "session_mode_set",
      data: { mode: session.mode, spec_path: session.spec_path },
    });
    if (session.mode === "spec" && session.spec_path?.trim()) {
      const created = await ensureSpecFile(session.spec_path);
      if (created) {
        await this.store.appendSessionEvent(sessionId, {
          ts: new Date().toISOString(),
          session_id: sessionId,
          type: "spec_created",
          data: { spec_path: session.spec_path },
        });
      }
    }
    const resp: UpdateSessionModeResponse = {
      session_id: session.id,
      mode: session.mode,
      spec_path: session.spec_path,
    };
    return jsonResponse(resp);
  }

  private async handleSessionMessage(req: Request, sessionId: string): Promise<Response> {
    let body: AddMessageRequest;
    try {
      body = await this.parseJSON<AddMessageRequest>(req);
    } catch {
      return errorResponse("invalid json", 400);
    }
    const role = body.role?.trim();
    if (!role) return errorResponse("role required", 400);
    const parts = body.parts ?? [];
    const msg = {
      id: newMessageId(),
      role,
      parts: parts.map((part) => ({
        type: part.type,
        text: part.text,
        ref: part.ref,
        mime_type: part.mime_type,
      })),
      created_at: new Date().toISOString(),
    };
    try {
      await this.store.appendMessage(sessionId, msg);
    } catch (err: unknown) {
      return errorResponse((err as Error).message, 400);
    }
    await this.store.appendSessionEvent(sessionId, {
      ts: new Date().toISOString(),
      session_id: sessionId,
      type: "message_added",
      data: { message_id: msg.id, role: msg.role },
    });

    const turnId = await this.store.addTurn(sessionId);
    if (body.auto_run ?? true) {
      if (!this.sessionRunner) return errorResponse("session runner not configured", 500);
      await this.sessionRunner.startTurn(sessionId, turnId);
    }

    const resp: AddMessageResponse = {
      message_id: msg.id,
      turn_id: turnId,
    };
    return jsonResponse(resp);
  }

  private async handleSessionApprove(req: Request, sessionId: string): Promise<Response> {
    let body: SessionApproveRequest;
    try {
      body = await this.parseJSON<SessionApproveRequest>(req);
    } catch {
      return errorResponse("invalid json", 400);
    }
    if (!body.tool_call_id?.trim()) return errorResponse("tool_call_id required", 400);
    const action = body.action?.trim() || "approve";
    try {
      await this.store.approveSessionToolCall(sessionId, body.tool_call_id, {
        action,
        reason: body.reason,
      });
      await this.store.appendSessionEvent(sessionId, {
        ts: new Date().toISOString(),
        session_id: sessionId,
        turn_id: body.turn_id,
        type: action === "deny" ? "approval_denied" : "approval_granted",
        data: { tool_call_id: body.tool_call_id, reason: body.reason },
      });
      return jsonResponse({ ok: true });
    } catch (err: unknown) {
      return errorResponse((err as Error).message, 400);
    }
  }

  private async handleSessionAttachment(req: Request, sessionId: string): Promise<Response> {
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.startsWith("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return errorResponse("file required", 400);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const name = file.name;
      const mimeType = file.type;
      const { ref, mime_type } = await this.store.saveSessionAttachment(sessionId, name, mimeType, bytes);
      const resp: AttachmentUploadResponse = { ref, mime_type };
      return jsonResponse(resp);
    }

    let body: AttachmentUploadRequest;
    try {
      body = await this.parseJSON<AttachmentUploadRequest>(req);
    } catch {
      return errorResponse("invalid json", 400);
    }
    if (!body.content_base64?.trim()) return errorResponse("content_base64 required", 400);
    let content: Uint8Array;
    try {
      content = Uint8Array.from(Buffer.from(body.content_base64, "base64"));
    } catch {
      return errorResponse("invalid base64 content", 400);
    }
    const { ref, mime_type } = await this.store.saveSessionAttachment(
      sessionId,
      body.name ?? "",
      body.mime_type ?? "",
      content,
    );
    const resp: AttachmentUploadResponse = { ref, mime_type };
    return jsonResponse(resp);
  }

  private async handleSessionEvents(req: Request, sessionId: string): Promise<Response> {
    const url = new URL(req.url);
    if (url.searchParams.get("format") === "json") {
      const max = Number(url.searchParams.get("max") ?? "0");
      const events = await this.store.readSessionEvents(sessionId, Number.isNaN(max) ? 0 : max);
      return jsonResponse(events);
    }

    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const history = await this.store.readSessionEvents(sessionId, 200).catch(() => []);
        for (const ev of history) {
          controller.enqueue(encoder.encode(formatSSE("message", ev)));
        }
        unsubscribe = this.store.subscribeSession(sessionId, (ev) => {
          controller.enqueue(encoder.encode(formatSSE("message", ev)));
        });

        const keepAlive = setInterval(() => {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        }, 15_000);

        req.signal.addEventListener("abort", () => {
          clearInterval(keepAlive);
          unsubscribe?.();
          controller.close();
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  private async handleSpecGenerate(req: Request): Promise<Response> {
    if (req.method !== "POST") return new Response(null, { status: 405 });
    if (!this.specGen) return errorResponse("spec generator not configured", 500);
    let body: GenerateSpecRequest;
    try {
      body = await this.parseJSON<GenerateSpecRequest>(req);
    } catch {
      return errorResponse("invalid json", 400);
    }
    const workspace = body.workspace_path?.trim();
    const specName = body.spec_name?.trim();
    const prompt = body.prompt?.trim();
    if (!workspace || !specName || !prompt) {
      return errorResponse("workspace_path, spec_name, and prompt are required", 400);
    }
    if (!isSafeSpecName(specName)) {
      return errorResponse("spec_name must be alphanumeric with dashes or underscores", 400);
    }
    try {
      const info = await stat(workspace);
      if (!info.isDirectory()) {
        return errorResponse("workspace_path must be a directory", 400);
      }
    } catch {
      return errorResponse("workspace_path must be a directory", 400);
    }

    const specRel = path.posix.join("specs", specName, "spec.md");
    let specAbs: string;
    try {
      specAbs = safeWorkspaceJoin(workspace, specRel);
    } catch (err: unknown) {
      return errorResponse((err as Error).message, 400);
    }

    if (!body.overwrite) {
      try {
        await stat(specAbs);
        return errorResponse("spec already exists", 409);
      } catch {
        // ok
      }
    }

    const content = await this.specGen.generateSpec(workspace, specName, prompt);
    await mkdir(path.dirname(specAbs), { recursive: true, mode: 0o755 });
    const diagDir = path.join(path.dirname(specAbs), "diagrams");
    await mkdir(diagDir, { recursive: true, mode: 0o755 });
    await writeFile(specAbs, content, { mode: 0o644 });

    const resp: GenerateSpecResponse = { spec_path: specAbs, content };
    return jsonResponse(resp);
  }

  private async handleModels(req: Request): Promise<Response> {
    if (req.method !== "GET") return new Response(null, { status: 405 });
    if (!this.modelSvc) return errorResponse("model service not configured", 500);
    const models = await this.modelSvc.listModels();
    return jsonResponse({ models, policy: this.modelSvc.getPolicy() });
  }

  private async handleModelPolicy(req: Request): Promise<Response> {
    if (!this.modelSvc) return errorResponse("model service not configured", 500);
    if (req.method === "GET") {
      return jsonResponse(this.modelSvc.getPolicy());
    }
    if (req.method === "POST") {
      let policy: ModelPolicy;
      try {
        policy = await this.parseJSON<ModelPolicy>(req);
      } catch {
        return errorResponse("invalid json", 400);
      }
      await this.modelSvc.setPolicy(policy);
      return jsonResponse(this.modelSvc.getPolicy());
    }
    return new Response(null, { status: 405 });
  }

  private async handleWorkspaceTree(req: Request): Promise<Response> {
    if (req.method !== "GET") return new Response(null, { status: 405 });
    const url = new URL(req.url);
    const workspace = url.searchParams.get("workspace_path")?.trim();
    if (!workspace) return errorResponse("workspace_path required", 400);
    try {
      const info = await stat(workspace);
      if (!info.isDirectory()) throw new Error();
    } catch {
      return errorResponse("workspace_path must be a directory", 400);
    }
    const { defaultWalkOptions, walkFiles } = await import("../util/files");
    const opts = defaultWalkOptions();
    opts.maxFiles = 800;
    opts.maxDepth = 8;
    const files = await walkFiles(workspace, opts);
    return jsonResponse({ root: workspace, files });
  }

  private async handleRunEvents(req: Request, runId: string): Promise<Response> {
    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const history = await this.store.readEvents(runId, 200).catch(() => []);
        for (const ev of history) {
          controller.enqueue(encoder.encode(formatSSE("message", ev)));
        }
        unsubscribe = this.store.subscribe(runId, (ev) => {
          controller.enqueue(encoder.encode(formatSSE("message", ev)));
        });
        const keepAlive = setInterval(() => {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        }, 15_000);
        req.signal.addEventListener("abort", () => {
          clearInterval(keepAlive);
          unsubscribe?.();
          controller.close();
        });
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }
}

function formatSSE(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function isSafeSpecName(name: string): boolean {
  if (!name) return false;
  for (const ch of name) {
    if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "-" || ch === "_") {
      continue;
    }
    return false;
  }
  return true;
}

function safeWorkspaceJoin(workspace: string, rel: string): string {
  const root = path.resolve(workspace);
  const abs = path.resolve(root, rel);
  const relPath = path.relative(root, abs);
  if (relPath === ".." || relPath.startsWith(`..${path.sep}`)) {
    throw new Error(`path escapes workspace: ${rel}`);
  }
  return abs;
}

async function resolveSpecPath(workspace: string, specPath: string): Promise<string> {
  if (!specPath.trim()) throw new Error("spec_path is empty");
  const root = path.resolve(workspace);
  if (path.isAbsolute(specPath)) {
    const abs = path.resolve(specPath);
    const relPath = path.relative(root, abs);
    if (relPath === ".." || relPath.startsWith(`..${path.sep}`)) {
      throw new Error(`spec_path escapes workspace: ${specPath}`);
    }
    return abs;
  }
  return safeWorkspaceJoin(root, specPath);
}
