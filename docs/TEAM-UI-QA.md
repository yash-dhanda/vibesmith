# Team Mode UI QA

Started: 2026-11-03 23:57:44 IST (`1793730464`).

This is a live checklist. Real-agent use is capped at three tiny runs; replay and synthetic CDP fixtures cover everything else.

- [x] Phase 1 — reducer and event handling tests
- [x] Phase 2 — stress and performance
- [ ] Phase 3 — backend failure and edge states
- [ ] Phase 4 — real end-to-end runs
- [ ] Phase 5 — defaults and run list
- [ ] Phase 6 — accessibility and polish
- [ ] Phase 7 — documentation and final audit

## Findings log

| Phase | Status | Tested | Bugs found and fixed | Deferred |
| --- | --- | --- | --- | --- |
| 1 | Complete | Pure reducer tests: delta merge/final replacement, code replacement, live files, prompts, timestamp ordering, duplicate messages, task-before-plan, unknown events, lane cap, live/replay parity. | Reducer was coupled to DOM state and unbounded. Extracted `teamReducer.ts`, bounded each lane to 240 rows plus 200 non-agent events, ignored unknown events, sorted timestamped replay, and avoided cloning the run for high-rate display-only events. Commit recorded in history. | None. |
| 2 | Complete | Replay: 20,000 deltas, 300 tools, 50 replacements of a 5,000-line file, 30 chained tasks, 200 KB output, a 27 KB unbroken line, emoji and RTL. CDP checked long tasks, heap, row caps, overflow and renderer exceptions. | Full-page replacement during live events caused focus/scroll loss; lane-only updates now preserve follow position. Added a 240-row cap per lane, 200 other-event cap, 40-row DOM window, preserved steering drafts, and chunked restart replay. | A deliberately synchronous 20k-event fixture still has a 104 ms load task; real deltas arrive over time and use incremental lane rendering. |
| 3 | Not started | — | — | — |
| 4 | Not started | — | — | — |
| 5 | Not started | — | — | — |
| 6 | Not started | — | — | — |
| 7 | Not started | — | — | — |

## Performance measurements

Synthetic unbounded baseline: rendering 20,000 activity rows took 325 ms. Before chunked replay, the stress screen became ready in 262 ms but produced a 184 ms longest task and used 39.6 MB JS heap. After bounding and chunking, it became ready in 392 ms, longest task fell to 104 ms, heap fell to 26.0 MB, each visible lane held 40 rows, all 30 task cards rendered, horizontal overflow was 0 px, and there were zero renderer exceptions. Total load is intentionally traded for shorter blocking work.

## Real-agent budget

0 of 3 runs used.

## Known limitations

Pending final audit.
