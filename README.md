# opencode-herdr-agents

An OpenCode plugin that gives the orchestrating agent a small worker API backed by real Herdr tabs.

Each `spawn_herdr_worker` call creates a background tab in the current Herdr workspace, starts a new OpenCode session there, submits the task, and returns control to the first tab. The orchestrator can then send follow-ups, wait for a result, inspect live workers, or close the worker tab.

This first release intentionally supports **OpenCode workers only**.

## Demo

[Watch the 34-second Herdr worker lifecycle](./assets/herdr-worker-demo.mp4): create an OpenCode worker in a background tab, send a follow-up, read its result, and close it.

## Tools

| Tool | Behavior |
| --- | --- |
| `spawn_herdr_worker` | Create a named background tab, start a new or forked OpenCode session with an optional model and variant, and submit the initial task. |
| `prompt_herdr_worker` | Send a follow-up prompt; optionally interrupt the active turn first. |
| `wait_herdr_worker` | Wait for the first target to settle or block, then return its recent terminal transcript. |
| `list_herdr_workers` | List live Herdr workers with their tab, pane, and lifecycle state. |
| `close_herdr_worker` | Stop a worker and close the tab created for it. |

The lifecycle and result shapes deliberately track Codex's multi-agent API. Fresh workers do not inherit the parent OpenCode transcript, while workers created with `fork_current_session` do. In both modes, `spawn_herdr_worker.message` should state the worker's task concretely. There is no `resume_herdr_worker` in this first pass because `close_herdr_worker` destroys the worker tab.

## Requirements

- [Herdr](https://github.com/herdrdev/herdr) 0.8.0 or newer
- OpenCode 1.18.5 or newer with its Herdr integration installed
- Git, used by OpenCode to fetch the public plugin repository

The `herdr`, `opencode`, and `git` executables must be available on `PATH`.

## Install

Install Herdr's official OpenCode lifecycle integration and then add this plugin globally:

```bash
herdr integration install opencode
opencode plugin --global github:fermumen/opencode-herdr-agents
```

Restart OpenCode after installing. OpenCode records the plugin in its global config and manages the checkout and dependencies in its package cache; no manual clone, `npm install`, or symlink is needed.

To update:

```bash
opencode plugin --global --force github:fermumen/opencode-herdr-agents
```

OpenCode does not currently provide a plugin uninstall command. To uninstall, remove `github:fermumen/opencode-herdr-agents` from the `plugin` array in the global OpenCode config (`~/.config/opencode/opencode.json` or `opencode.jsonc`), then restart OpenCode.

## Use

Start OpenCode inside a Herdr pane. The tools are exposed only when the plugin sees Herdr's pane environment; ordinary OpenCode sessions do not pay the tool-schema cost.

A typical tool call is:

```json
{
  "task_name": "review_auth",
  "message": "Review the authentication changes in this workspace. Do not edit files. Return concrete findings with file paths and line numbers.",
  "model": "openai/gpt-5.4",
  "reasoning_effort": "high",
  "fork_current_session": true
}
```

`task_name` must match `[a-z][a-z0-9_-]{0,31}`. `model` uses OpenCode's `provider/model` syntax. `reasoning_effort` is passed to OpenCode as `--variant`, so supported values depend on the selected provider and model.

Set `fork_current_session` to `true` to launch the worker from a fork of the session that called the tool. The fork receives the conversation and prior tool results available at spawn time, but continues independently in the background. This can avoid repeating repository discovery and can preserve a cacheable prompt prefix. The default is `false`, which starts a fresh OpenCode session as before.

The intended lifecycle is:

1. `spawn_herdr_worker` with a complete task prompt.
2. Continue other work in the orchestrating tab.
3. Call `wait_herdr_worker` with the returned `agent_id`, or use `list_herdr_workers` to poll status.
4. Use `prompt_herdr_worker` for a follow-up.
5. Call `close_herdr_worker` when the worker is no longer needed.

Workers start with `HERDR_AGENT_WORKER=1`, which prevents the plugin from exposing nested spawn tools in worker tabs. Set `HERDR_AGENTS_ALLOW_NESTED=1` before launching the parent OpenCode session if you explicitly want recursive orchestration.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `HERDR_BIN` | `herdr` | Override the Herdr executable path. |
| `HERDR_AGENTS_START_TIMEOUT_MS` | `30000` | Wait for a new OpenCode session to become interactive. Range: 3001–300000 ms. |
| `HERDR_AGENTS_READ_LINES` | `120` | Recent unwrapped terminal lines returned by `wait_herdr_worker`. Range: 20–1000. |
| `HERDR_AGENTS_ALLOW_NESTED` | unset | Set to `1` to expose the tools inside spawned worker tabs too. |

## Development

The lifecycle core has no OpenCode dependency, so its command construction can be tested with Node's built-in test runner:

```bash
npm install
npm run check
npm test
```

## License

MIT
