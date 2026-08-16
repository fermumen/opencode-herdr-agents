import assert from "node:assert/strict"
import test from "node:test"

import { HerdrAgentsPlugin } from "../src/index.js"

test("exposes the Herdr-specific worker tool name", async () => {
  const keys = [
    "HERDR_ENV",
    "HERDR_SOCKET_PATH",
    "HERDR_WORKSPACE_ID",
    "HERDR_PANE_ID",
    "HERDR_AGENT_WORKER",
  ]
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]))

  Object.assign(process.env, {
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: "/tmp/herdr.sock",
    HERDR_WORKSPACE_ID: "w1",
    HERDR_PANE_ID: "w1:p1",
  })
  delete process.env.HERDR_AGENT_WORKER

  try {
    const plugin = await HerdrAgentsPlugin()
    assert.deepEqual(Object.keys(plugin.tool), [
      "spawn_herdr_worker",
      "send_input",
      "wait_agent",
      "close_agent",
      "list_agents",
    ])
    assert.equal(plugin.tool.spawn_agent, undefined)
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
