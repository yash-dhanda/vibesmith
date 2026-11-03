# CDP visual review

Captured from the built Electron app with `Page.captureScreenshot`, 2026-11-03. Desktop screens are 1440 × 960; narrow screens are 900 × 820. Fixture conversations and live approval events are synthetic, while dialogs, model availability and hardware data use the real bridge.

| Surface | Dark | Light |
| --- | --- | --- |
| Before redesign | [Before](before-dark.png) | [Before](before-light.png) |
| Empty build | [After](after-empty-dark.png) | [After](after-empty-light.png) |
| Project, plan and changes | [After](after-project-dark.png) | [After](after-project-light.png) |
| Approval | [After](after-approval-dark.png) | [After](after-approval-light.png) |
| Settings | [After](after-settings-dark.png) | [After](after-settings-light.png) |
| Model library | [After](after-library-dark.png) | [After](after-library-light.png) |
| 500-message chat | [After](after-long-dark.png) | [After](after-long-light.png) |
| Narrow window | [After](after-narrow-dark.png) | [After](after-narrow-light.png) |

Additional views: [command palette](after-palette-dark.png), [narrow build brief](after-narrow-brief-dark.png).

## Team Mode

These captures use the renderer’s deterministic replay harness, so no Claude, Codex, Ollama, or agent quota was consumed.

| State | Light | Dark |
| --- | --- | --- |
| Composer entry | [Light](team-composer-entry-light.png) | — |
| Start and previous runs | [Light](team-entry-light.png) | [Dark](team-entry-dark.png) |
| One agent unavailable | [Light](team-entry-unavailable-light.png) | [Dark](team-entry-unavailable-dark.png) |
| Planning | [Light](team-planning-light.png) | [Dark](team-planning-dark.png) |
| Live run | [Light](team-running-light.png) | [Dark](team-running-dark.png) |
| Blocking approval | [Light](team-approval-light.png) | [Dark](team-approval-dark.png) |
| Usage pause | [Light](team-paused-light.png) | [Dark](team-paused-dark.png) |
| Restart recovery | [Light](team-interrupted-light.png) | [Dark](team-interrupted-dark.png) |
| Final Apply / Don’t apply | [Light](team-final-light.png) | [Dark](team-final-dark.png) |
| Narrow window | [Light](team-narrow-light.png) | [Dark](team-narrow-dark.png) |

[Team functional results](team-functional-review.json) record the CDP assertions and zero renderer exceptions.

The functional review used temporary files and a real git checkpoint under `/tmp/p`; no user projects were modified. [Functional results](functional-review.json) and [single-host fresh-profile startup timing](startup-review.json) record the tested behavior and timing limitations. See [DESIGN.md](../DESIGN.md) for the launch command, checks, implementation choices and remaining integration work.
