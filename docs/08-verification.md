# Verification

Verification enables self-correcting loops in the graph. When a Verifier node runs, its output can feed back into upstream nodes to trigger fixes.

## Verifier Node Role

A Verifier node executes configured commands and produces structured reports. Use this role in:
- **Feedback Loops**: `Coder <-> Verifier` - failures route back to Coder
- **Gate Patterns**: Verifier output determines if workflow continues
- **Quality Checks**: Final validation before marking work complete

## Deterministic Commands (v0)

Configure verification commands per node or globally:

```json
{
  "verification": {
    "commands": [
      "npm test",
      "npm run lint",
      "npm run build"
    ]
  }
}
```

The Verifier node runs each command and captures:
- exit code
- stdout/stderr
- duration

Output is a `VerificationReport` artifact.

## Verification in Global Modes

### Implementation Mode

Verifier runs actual commands:
- Tests (unit, integration)
- Linters
- Build processes
- Type checks

Pass/fail determines loop continuation.

### Planning Mode

Verifier checks for **Plan Completeness**:
- Required docs exist
- No contradictions in specs
- Acceptance criteria defined
- Architecture documented

## Example Patterns

### Self-Correcting Loop

```
Coder (Auto) <-> Verifier (Auto)
```

1. Coder writes implementation
2. Verifier runs tests
3. If fail: Output routes back to Coder with error context
4. Coder fixes and re-outputs
5. Loop continues until pass

### Gated Pipeline

```
Coder -> Verifier -> DocWriter
```

1. Coder outputs implementation
2. Verifier validates
3. Only on pass: DocWriter receives handoff

## AI Reviewer

The Verifier role can also use AI for subjective checks:
- Code quality assessment
- Security review
- Best practices compliance

Configure via custom instructions on the Verifier node.
