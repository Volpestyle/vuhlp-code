import type { Kit, ModelRecord, Message } from "@volpestyle/ai-kit-node";
import { newStepId } from "../util/id";
import type { ContextBundle } from "./context";

export interface Plan {
  steps: PlanStep[];
}

export interface PlanStep {
  id: string;
  title: string;
  type: string;
  needs_approval: boolean;
  command?: string;
  patch?: string;
}

export function defaultPlan(): Plan {
  return {
    steps: [
      {
        id: newStepId(),
        title: "Run tests",
        type: "command",
        needs_approval: false,
        command: "make test",
      },
      {
        id: newStepId(),
        title: "Render diagrams (best effort)",
        type: "command",
        needs_approval: false,
        command: "make diagrams",
      },
    ],
  };
}

export async function generatePlan(
  kit: Kit,
  model: ModelRecord,
  specText: string,
  bundle: ContextBundle,
): Promise<Plan> {
  if (!kit) throw new Error("kit is nil");
  const prompt = buildPlanningPrompt(specText, bundle);
  const messages: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: prompt }],
    },
  ];
  const output = await kit.generate({
    provider: model.provider,
    model: model.providerModelId,
    messages,
  });
  try {
    const plan = parsePlanFromText(output.text ?? "");
    normalizePlan(plan);
    return plan;
  } catch {
    return defaultPlan();
  }
}

function buildPlanningPrompt(specText: string, bundle: ContextBundle): string {
  let out = "";
  out += "You are an expert coding-agent planner.\n";
  out += "Return JSON ONLY (no markdown, no code fences) with this exact schema:\n\n";
  out +=
    '{"steps":[{"id":"step_...","title":"...","type":"command|patch|diagram|note","needs_approval":true|false,"command":"...","patch":"..."}]}\n\n';
  out += "Rules:\n";
  out += "- Use needs_approval=true for any destructive command or infra change.\n";
  out += "- Use type=patch with a unified diff in patch when you propose code edits.\n";
  out += "- Keep the step list short and executable.\n\n";
  out += "SPEC:\n";
  out += specText + "\n\n";
  if (bundle.agents_md) {
    out += "AGENTS.md:\n" + bundle.agents_md + "\n\n";
  }
  if (bundle.repo_map) {
    out += "REPO MAP (symbols):\n" + bundle.repo_map + "\n\n";
  }
  if (bundle.git_status) {
    out += "GIT STATUS:\n" + bundle.git_status + "\n\n";
  }
  return out;
}

export function parsePlanFromText(text: string): Plan {
  let s = text.trim();
  s = s.replace(/^```json/, "").replace(/^```/, "").replace(/```$/, "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) {
    s = s.slice(start, end + 1);
  }
  const plan = JSON.parse(s) as Plan;
  if (!plan.steps || plan.steps.length === 0) {
    throw new Error("no steps in plan");
  }
  return plan;
}

function normalizePlan(plan: Plan): void {
  for (const step of plan.steps) {
    if (!step.id || !step.id.trim()) step.id = newStepId();
    if (!step.title || !step.title.trim()) step.title = step.type;
    if (!step.type || !step.type.trim()) step.type = "note";
  }
}
