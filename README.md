# opencode-herdr-agents

An OpenCode plugin that gives the orchestrating agent a small worker API backed by real Herdr tabs.

Each `spawn_herdr_worker` call creates a background tab in the current Herdr workspace, starts a new OpenCode session there, submits the task, and returns control to the first tab. The orchestrator can then send follow-ups, wait for a result, inspect live agents, or close the worker tab.

This first release intentionally supports **OpenCode workers only**.

## Tools

| Tool | Behavior |
| --- | --- |
| `spawn_herdr_worker` | Create a named background tab, start OpenCode with an optional model and variant, and submit the initial task. |
| `send_input` | Send a follow-up prompt; optionally interrupt the active turn first. |
| `wait_agent` | Wait for the first target to settle or block, then return its recent terminal transcript. |
| `list_agents` | List live Herdr agents with their tab, pane, and lifecycle state. |
| `close_agent` | Stop a worker and close the tab created for it. |

The lifecycle and result shapes deliberately track Codex's multi-agent API. A separate terminal process cannot inherit the parent OpenCode transcript, so `spawn_herdr_worker.message` must be self-contained. There is no `resume_agent` in this first pass because `close_agent` destroys the worker tab.

## Requirements

- [Herdr](https://github.com/herdrdev/herdr) 0.8.0 or newer
- OpenCode with its Herdr integration installed
- Git and Node.js 22 or newer for this source install

The `herdr`, `opencode`, and `node` executables must be available on `PATH`.

## Install

First install Herdr's official OpenCode lifecycle integration:

```bash
herdr integration install opencode
```

Then install this plugin globally:

```bash
git clone https://github.com/fermumen/opencode-herdr-agents.git \
  ~/.config/opencode/opencode-herdr-agents

cd ~/.config/opencode/opencode-herdr-agents
npm install --omit=dev

mkdir -p ~/.config/opencode/plugins
ln -s "$PWD/src/index.js" ~/.config/opencode/plugins/herdr-agents.js
```

Restart OpenCode after installing. OpenCode loads files in `~/.config/opencode/plugins/` automatically.

To update:

```bash
cd ~/.config/opencode/opencode-herdr-agents
git pull --ff-only
npm install --omit=dev
```

To uninstall:

```bash
rm ~/.config/opencode/plugins/herdr-agents.js
rm -rf ~/.config/opencode/opencode-herdr-agents
```

## Use

Start OpenCode inside a Herdr pane. The tools are exposed only when the plugin sees Herdr's pane environment; ordinary OpenCode sessions do not pay the tool-schema cost.

A typical tool call is:

```json
{
  "task_name": "review_auth",
  "message": "Review the authentication changes in this workspace. Do not edit files. Return concrete findings with file paths and line numbers.",
  "model": "openai/gpt-5.4",
  "reasoning_effort": "high"
}
```

`task_name` must match `[a-z][a-z0-9_-]{0,31}`. `model` uses OpenCode's `provider/model` syntax. `reasoning_effort` is passed to OpenCode as `--variant`, so supported values depend on the selected provider and model.

The intended lifecycle is:

1. `spawn_herdr_worker` with a complete task prompt.
2. Continue other work in the orchestrating tab.
3. Call `wait_agent` with the returned `agent_id`, or use `list_agents` to poll status.
4. Use `send_input` for a follow-up.
5. Call `close_agent` when the worker is no longer needed.

Workers start with `HERDR_AGENT_WORKER=1`, which prevents the plugin from exposing nested spawn tools in worker tabs. Set `HERDR_AGENTS_ALLOW_NESTED=1` before launching the parent OpenCode session if you explicitly want recursive orchestration.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `HERDR_BIN` | `herdr` | Override the Herdr executable path. |
| `HERDR_AGENTS_START_TIMEOUT_MS` | `30000` | Wait for a new OpenCode session to become interactive. Range: 3001–300000 ms. |
| `HERDR_AGENTS_READ_LINES` | `120` | Recent unwrapped terminal lines returned by `wait_agent`. Range: 20–1000. |
| `HERDR_AGENTS_ALLOW_NESTED` | unset | Set to `1` to expose the tools inside spawned worker tabs too. |

## Development

The lifecycle core has no OpenCode dependency, so its command construction can be tested with Node's built-in test runner:

```bash
npm run check
npm test
```

## License

MIT
