# Loop safety and non-progress detection

## Status in v0

- Each node tracks output hash, diff hash, and verification failure signature.
- If a signal repeats for `VUHLP_STALL_THRESHOLD` turns (default 20), the run is paused.
- A `run.stalled` event is emitted with evidence.

## Notes

- Diff/verification signals are optional and only used when available.
- There is no cycle detection or per-cycle budget in v0.
