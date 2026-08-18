import assert from "node:assert/strict"
import test from "node:test"

import { createHerdrAgents, HerdrCommandError, pluginIsAvailable } from "../src/core.js"

function json(result) {
  return { stdout: JSON.stringify({ result }), stderr: "" }
}

function fakeRunner(steps) {
  const calls = []
  const run = async (args) => {
    calls.push(args)
    const step = steps.shift()
    assert.ok(step, `unexpected command: ${args.join(" ")}`)
    if (typeof step === "function") return step(args)
    return step
  }
  return { run, calls }
}

test("registers only in a top-level Herdr pane", () => {
  const env = {
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: "/tmp/herdr.sock",
    HERDR_WORKSPACE_ID: "w1",
    HERDR_PANE_ID: "w1:p1",
  }
  assert.equal(pluginIsAvailable(env), true)
  assert.equal(pluginIsAvailable({ ...env, HERDR_AGENT_WORKER: "1" }), false)
  assert.equal(
    pluginIsAvailable({ ...env, HERDR_AGENT_WORKER: "1", HERDR_AGENTS_ALLOW_NESTED: "1" }),
    true,
  )
  assert.equal(pluginIsAvailable({}), false)
})

test("spawn_herdr_worker waits for Herdr to acknowledge the initial prompt", async () => {
  const agent = {
    name: "review_auth",
    agent_status: "working",
    tab_id: "w1:t2",
    pane_id: "w1:p2",
  }
  const fake = fakeRunner([
    json({ tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } }),
    json({ agent }),
    json({ agent }),
  ])
  const agents = createHerdrAgents({
    run: fake.run,
    env: { HERDR_WORKSPACE_ID: "w1" },
  })

  const result = await agents.spawnAgent(
    {
      task_name: "review_auth",
      message: "Review the auth flow",
      model: "openai/gpt-5.4",
      reasoning_effort: "high",
    },
    "/repo",
  )

  assert.deepEqual(result, {
    agent_id: "review_auth",
    task_name: "review_auth",
    nickname: "review_auth",
    tab_id: "w1:t2",
    pane_id: "w1:p2",
    status: "running",
  })
  assert.deepEqual(fake.calls, [
    [
      "tab",
      "create",
      "--workspace",
      "w1",
      "--cwd",
      "/repo",
      "--label",
      "review_auth",
      "--env",
      "HERDR_AGENT_WORKER=1",
      "--no-focus",
    ],
    [
      "agent",
      "start",
      "review_auth",
      "--kind",
      "opencode",
      "--pane",
      "w1:p2",
      "--timeout",
      "30000",
      "--",
      "--model",
      "openai/gpt-5.4",
      "--variant",
      "high",
    ],
    [
      "agent",
      "prompt",
      "review_auth",
      "Review the auth flow",
      "--wait",
      "--until",
      "working",
      "--until",
      "idle",
      "--until",
      "done",
      "--until",
      "blocked",
      "--timeout",
      "30000",
    ],
  ])
})

test("spawn_herdr_worker retries once when the initial prompt stalls", async () => {
  const agent = {
    name: "review_auth",
    agent_status: "working",
    tab_id: "w1:t2",
    pane_id: "w1:p2",
  }
  const fake = fakeRunner([
    json({ tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } }),
    json({ agent }),
    (args) => {
      throw new HerdrCommandError(
        args,
        1,
        "",
        JSON.stringify({ error: { code: "agent_prompt_stalled" } }),
      )
    },
    json({ agent }),
  ])
  const agents = createHerdrAgents({
    run: fake.run,
    env: { HERDR_WORKSPACE_ID: "w1", HERDR_AGENTS_START_TIMEOUT_MS: "4000" },
  })

  const result = await agents.spawnAgent(
    { task_name: "review_auth", message: "Review the auth flow" },
    "/repo",
  )

  assert.equal(result.status, "running")
  assert.deepEqual(fake.calls[1].slice(-2), ["--timeout", "4000"])
  assert.deepEqual(fake.calls[2], fake.calls[3])
  assert.deepEqual(fake.calls[2].slice(-2), ["--timeout", "6000"])
})

test("spawn_herdr_worker can fork the current OpenCode session", async () => {
  const agent = {
    name: "review_auth",
    agent_status: "working",
    tab_id: "w1:t2",
    pane_id: "w1:p2",
  }
  const fake = fakeRunner([
    json({ tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } }),
    json({ agent }),
    json({ agent }),
  ])
  const agents = createHerdrAgents({
    run: fake.run,
    env: { HERDR_WORKSPACE_ID: "w1" },
  })

  const result = await agents.spawnAgent(
    {
      task_name: "review_auth",
      message: "Review the auth flow",
      fork_current_session: true,
    },
    "/repo",
    "ses_parent",
  )

  assert.equal(result.forked_from_session_id, "ses_parent")
  assert.deepEqual(fake.calls[1], [
    "agent",
    "start",
    "review_auth",
    "--kind",
    "opencode",
    "--pane",
    "w1:p2",
    "--timeout",
    "30000",
    "--",
    "--session",
    "ses_parent",
    "--fork",
  ])
})

test("spawn_herdr_worker validates the current session before creating a forked worker tab", async () => {
  const fake = fakeRunner([])
  const agents = createHerdrAgents({
    run: fake.run,
    env: { HERDR_WORKSPACE_ID: "w1" },
  })

  await assert.rejects(
    agents.spawnAgent(
      {
        task_name: "review_auth",
        message: "Review the auth flow",
        fork_current_session: true,
      },
      "/repo",
    ),
    /current OpenCode session id is unavailable/,
  )
  assert.deepEqual(fake.calls, [])
})

test("wait_herdr_worker returns the first settled worker transcript", async () => {
  const fake = fakeRunner([
    json({
      agent: {
        name: "review_auth",
        agent_status: "done",
        tab_id: "w1:t2",
        pane_id: "w1:p2",
      },
    }),
    { stdout: "Review complete: no findings.\n", stderr: "" },
  ])
  const agents = createHerdrAgents({ run: fake.run, env: {} })
  const result = await agents.waitAgent({ targets: ["review_auth"], timeout_ms: 5000 })

  assert.deepEqual(result, {
    status: { review_auth: { completed: "Review complete: no findings." } },
    timed_out: false,
    herdr_status: { review_auth: "done" },
  })
  assert.deepEqual(fake.calls, [
    ["agent", "wait", "review_auth", "--timeout", "5000"],
    ["agent", "read", "review_auth", "--source", "recent-unwrapped", "--lines", "120"],
  ])
})

test("close_herdr_worker interrupts a working agent and closes its owned tab", async () => {
  const fake = fakeRunner([
    json({
      agent: {
        name: "review_auth",
        agent_status: "working",
        tab_id: "w1:t2",
        pane_id: "w1:p2",
      },
    }),
    json({}),
    json({}),
  ])
  const agents = createHerdrAgents({ run: fake.run, env: {} })
  const result = await agents.closeAgent({ target: "review_auth" })

  assert.deepEqual(result, { previous_status: "running" })
  assert.deepEqual(fake.calls, [
    ["agent", "get", "review_auth"],
    ["agent", "send-keys", "review_auth", "ctrl+c"],
    ["tab", "close", "w1:t2"],
  ])
})
