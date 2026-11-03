# Team Mode UI QA

Started: 2026-11-03 23:57:44 IST (`1793730464`).

This is a live checklist. Real-agent use is capped at three tiny runs; replay and synthetic CDP fixtures cover everything else.

- [x] Phase 1 — reducer and event handling tests
- [ ] Phase 2 — stress and performance
- [ ] Phase 3 — backend failure and edge states
- [ ] Phase 4 — real end-to-end runs
- [ ] Phase 5 — defaults and run list
- [ ] Phase 6 — accessibility and polish
- [ ] Phase 7 — documentation and final audit

## Findings log

| Phase | Status | Tested | Bugs found and fixed | Deferred |
| --- | --- | --- | --- | --- |
| 1 | Complete | Pure reducer tests: delta merge/final replacement, code replacement, live files, prompts, timestamp ordering, duplicate messages, task-before-plan, unknown events, lane cap, live/replay parity. | Reducer was coupled to DOM state and unbounded. Extracted `teamReducer.ts`, bounded each lane to 240 rows plus 200 non-agent events, ignored unknown events, sorted timestamped replay, and avoided cloning the run for high-rate display-only events. Commit recorded in history. | None. |
| 2 | Not started | — | — | — |
| 3 | Not started | — | — | — |
| 4 | Not started | — | — | — |
| 5 | Not started | — | — | — |
| 6 | Not started | — | — | — |
| 7 | Not started | — | — | — |

## Performance measurements

Pending baseline and corrected-run CDP measurements.

## Real-agent budget

0 of 3 runs used.

## Known limitations

Pending final audit.
