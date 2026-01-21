import type { NodeRuntime } from "./store.js";

export interface StallEvidence {
  outputHash?: string;
  diffHash?: string;
  verificationFailure?: string;
  summaries: string[];
}

export function updateStallState(
  runtime: NodeRuntime,
  {
    outputHash,
    diffHash,
    verificationFailure,
    summary
  }: { outputHash?: string; diffHash?: string; verificationFailure?: string; summary: string },
  threshold: number
): { stalled: boolean; evidence?: StallEvidence } {
  runtime.summaryHistory.push(summary);
  if (runtime.summaryHistory.length > 3) {
    runtime.summaryHistory.shift();
  }

  if (outputHash && outputHash === runtime.lastOutputHash) {
    runtime.outputRepeatCount += 1;
  } else {
    runtime.outputRepeatCount = 0;
    runtime.lastOutputHash = outputHash;
  }

  if (diffHash && diffHash === runtime.lastDiffHash) {
    runtime.diffRepeatCount += 1;
  } else {
    runtime.diffRepeatCount = 0;
    runtime.lastDiffHash = diffHash;
  }

  if (verificationFailure && verificationFailure === runtime.lastVerificationFailure) {
    runtime.verificationRepeatCount += 1;
  } else {
    runtime.verificationRepeatCount = 0;
    runtime.lastVerificationFailure = verificationFailure;
  }

  const stalled =
    (outputHash && runtime.outputRepeatCount >= threshold) ||
    (diffHash && runtime.diffRepeatCount >= threshold) ||
    (verificationFailure && runtime.verificationRepeatCount >= threshold);

  if (!stalled) {
    return { stalled: false };
  }

  return {
    stalled: true,
    evidence: {
      outputHash,
      diffHash,
      verificationFailure,
      summaries: [...runtime.summaryHistory]
    }
  };
}
