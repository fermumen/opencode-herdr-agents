import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"

const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/
const SETTLED_STATES = new Set(["idle", "done", "blocked"])

export class HerdrCommandError extends Error {
  constructor(args, exitCode, stdout, stderr) {
    const detail = stderr.trim() || stdout.trim() || `exit code ${exitCode}`
    super(`herdr ${args.join(" ")} failed: ${detail}`)
    this.name = "HerdrCommandError"
    this.args = args
    this.exitCode = exitCode
    this.stdout = stdout
    this.stderr = stderr
  }
}

export function pluginIsAvailable(env = process.env) {
  const insideHerdr =
    env.HERDR_ENV === "1" &&
    Boolean(env.HERDR_SOCKET_PATH) &&
    Boolean(env.HERDR_WORKSPACE_ID) &&
    Boolean(env.HERDR_PANE_ID)
  const nestedWorker = env.HERDR_AGENT_WORKER === "1"
  return insideHerdr && (!nestedWorker || env.HERDR_AGENTS_ALLOW_NESTED === "1")
}

export function createSubprocessRunner({
  binary = process.env.HERDR_BIN || "herdr",
  env = process.env,
} = {}) {
  return (args, options = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(binary, args, {
        env,
        signal: options.signal,
        stdio: ["ignore", "pipe", "pipe"],
      })
      const stdout = []
      const stderr = []
      let settled = false

      child.stdout.on("data", (chunk) => stdout.push(chunk))
      child.stderr.on("data", (chunk) => stderr.push(chunk))
      child.on("error", (error) => {
        if (!settled) {
          settled = true
          reject(error)
        }
      })
      child.on("close", (exitCode) => {
        if (settled) return
        settled = true
        const output = Buffer.concat(stdout).toString("utf8")
        const errorOutput = Buffer.concat(stderr).toString("utf8")
        if (exitCode !== 0) {
          reject(new HerdrCommandError(args, exitCode, output, errorOutput))
          return
        }
        resolve({ stdout: output, stderr: errorOutput })
      })
    })
}

export function createHerdrAgents({ run, env = process.env } = {}) {
  if (typeof run !== "function") throw new TypeError("run must be a function")

  const readLines = integerEnv(env.HERDR_AGENTS_READ_LINES, 120, 20, 1000)
  const startTimeout = integerEnv(env.HERDR_AGENTS_START_TIMEOUT_MS, 30000, 3001, 300000)

  async function runJson(args, options) {
    const result = await run(args, options)
    try {
      return JSON.parse(result.stdout)
    } catch (error) {
      throw new Error(`herdr returned invalid JSON for ${args.join(" ")}: ${error.message}`)
    }
  }

  async function getAgent(target, options) {
    const response = await runJson(["agent", "get", target], options)
    return response.result.agent
  }

  async function readAgent(target, options) {
    const result = await run(
      ["agent", "read", target, "--source", "recent-unwrapped", "--lines", String(readLines)],
      options,
    )
    return result.stdout.trim()
  }

  async function spawnAgent(args, directory) {
    validateTaskName(args.task_name)
    if (!args.message?.trim()) throw new Error("message must not be empty")
    if (!env.HERDR_WORKSPACE_ID) throw new Error("HERDR_WORKSPACE_ID is unavailable")

    const created = await runJson([
      "tab",
      "create",
      "--workspace",
      env.HERDR_WORKSPACE_ID,
      "--cwd",
      directory,
      "--label",
      args.task_name,
      "--env",
      "HERDR_AGENT_WORKER=1",
      "--no-focus",
    ])
    const tabId = created.result.tab.tab_id
    const paneId = created.result.root_pane.pane_id

    const openCodeArgs = []
    if (args.model) openCodeArgs.push("--model", args.model)
    if (args.reasoning_effort) openCodeArgs.push("--variant", args.reasoning_effort)

    try {
      const startArgs = [
        "agent",
        "start",
        args.task_name,
        "--kind",
        "opencode",
        "--pane",
        paneId,
        "--timeout",
        String(startTimeout),
      ]
      if (openCodeArgs.length) startArgs.push("--", ...openCodeArgs)
      await runJson(startArgs)
      const prompted = await runJson(["agent", "prompt", args.task_name, args.message])
      const agent = prompted.result.agent
      return {
        agent_id: args.task_name,
        task_name: args.task_name,
        nickname: args.task_name,
        tab_id: tabId,
        pane_id: paneId,
        status: codexStatus(agent),
      }
    } catch (error) {
      try {
        await runJson(["tab", "close", tabId])
      } catch {
        // Preserve the launch error; the tab id is present in Herdr's command history.
      }
      throw error
    }
  }

  async function sendInput(args) {
    if (!args.message?.trim()) throw new Error("message must not be empty")
    if (args.interrupt) {
      await runJson(["agent", "send-keys", args.target, "ctrl+c"])
    }
    await runJson(["agent", "prompt", args.target, args.message])
    return { submission_id: randomUUID() }
  }

  async function waitOne(target, timeoutMs, signal) {
    try {
      const response = await runJson(
        ["agent", "wait", target, "--timeout", String(timeoutMs)],
        { signal },
      )
      const agent = response.result.agent
      const output = await readAgent(target, { signal })
      return { target, agent, output, timedOut: false }
    } catch (error) {
      if (signal.aborted) throw error
      if (isTimeoutError(error)) return { target, timedOut: true }
      return { target, error, timedOut: false }
    }
  }

  async function waitAgent(args) {
    const timeoutMs = args.timeout_ms ?? 10000
    const abort = new AbortController()
    try {
      const first = await Promise.race(
        args.targets.map((target) => waitOne(target, timeoutMs, abort.signal)),
      )
      if (first.timedOut) return { status: {}, timed_out: true }
      if (first.error) {
        return {
          status: { [first.target]: { errored: first.error.message } },
          timed_out: false,
        }
      }
      return {
        status: {
          [first.target]: { completed: first.output || null },
        },
        timed_out: false,
        herdr_status: {
          [first.target]: first.agent.agent_status,
        },
      }
    } finally {
      abort.abort()
    }
  }

  async function closeAgent(args) {
    const agent = await getAgent(args.target)
    const previousStatus = codexStatus(agent)
    if (agent.agent_status === "working") {
      try {
        await runJson(["agent", "send-keys", args.target, "ctrl+c"])
      } catch {
        // Closing the owned tab is the authoritative shutdown operation.
      }
    }
    await runJson(["tab", "close", agent.tab_id])
    return { previous_status: previousStatus }
  }

  async function listAgents() {
    const response = await runJson(["agent", "list"])
    return {
      agents: response.result.agents.map((agent) => ({
        agent_name: agent.name || agent.pane_id,
        agent_status: codexStatus(agent),
        herdr_status: agent.agent_status,
        tab_id: agent.tab_id,
        pane_id: agent.pane_id,
      })),
    }
  }

  return { spawnAgent, sendInput, waitAgent, closeAgent, listAgents }
}

function validateTaskName(name) {
  if (!AGENT_NAME.test(name || "")) {
    throw new Error("task_name must match [a-z][a-z0-9_-]{0,31}")
  }
}

function integerEnv(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback
}

function isTimeoutError(error) {
  if (!(error instanceof HerdrCommandError)) return false
  return /\btimeout\b/i.test(error.stderr) || /\btimeout\b/i.test(error.stdout)
}

function codexStatus(agent) {
  if (agent.launch_pending || agent.agent_status === "unknown") return "pending_init"
  if (agent.agent_status === "working" || agent.agent_status === "blocked") return "running"
  if (SETTLED_STATES.has(agent.agent_status)) return { completed: null }
  return "running"
}
