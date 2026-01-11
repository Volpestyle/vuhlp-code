# Verification

Verification is the key to the self-looping behavior.

## Deterministic verifier (v0)

Configured commands run in order:

```json
{
  "verification": {
    "commands": [
      "npm test",
      "npm run lint"
    ]
  }
}
```

The daemon runs each command and captures:

- exit code
- stdout/stderr
- duration

Then produces a `VerificationReport` artifact.

## AI reviewer (v0)

v0 includes a “reviewer” role hook, but is minimal by default.

In v1:
- add a dedicated reviewer node after implementation
- have it compare acceptance criteria vs diffs
- output structured report (pass/fail + issues)

## Completeness contract

At run creation time, derive a checklist:

- tests pass
- lint passes
- build passes
- docs updated (optional)
- no TODO added (optional)

This checklist is displayed and checked off in the UI.

v0 exposes the structure in the run state but does not fully enforce all items beyond commands.
