import path from "node:path";
import { stat, mkdir, writeFile } from "node:fs/promises";

export const defaultSpecContent = `# Goal

<describe the goal>

# Constraints / nuances

- <constraints>

# Acceptance tests

- <acceptance tests>
`;

export async function defaultSpecPath(workspacePath: string, name: string): Promise<string> {
  if (!workspacePath.trim()) throw new Error("workspace path is empty");
  if (!name.trim()) throw new Error("spec name is empty");
  const absWorkspace = path.resolve(workspacePath);
  return path.join(absWorkspace, "specs", name, "spec.md");
}

export async function ensureSpecFile(specPath: string): Promise<boolean> {
  if (!specPath.trim()) throw new Error("spec path is empty");
  try {
    await stat(specPath);
    return false;
  } catch {
    // continue
  }
  await mkdir(path.dirname(specPath), { recursive: true, mode: 0o755 });
  const content = defaultSpecContent.endsWith("\n") ? defaultSpecContent : `${defaultSpecContent}\n`;
  await writeFile(specPath, content, { mode: 0o644 });
  return true;
}
