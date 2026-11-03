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

The functional review used temporary files and a real git checkpoint under `/tmp/p`; no user projects were modified. [Functional results](functional-review.json) and [single-host fresh-profile startup timing](startup-review.json) record the tested behavior and timing limitations. See [DESIGN.md](../DESIGN.md) for the launch command, checks, implementation choices and remaining integration work.
