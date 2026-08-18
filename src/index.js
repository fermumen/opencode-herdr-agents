import { tool } from "@opencode-ai/plugin"
import { createHerdrAgents, createSubprocessRunner, pluginIsAvailable } from "./core.js"

export const HerdrAgentsPlugin = async () => {
  if (!pluginIsAvailable()) return {}

  const agents = createHerdrAgents({ run: createSubprocessRunner() })

  return {
    tool: {
      spawn_herdr_worker: tool({
        description:
          "Spawn an OpenCode worker in a named background tab in the current Herdr workspace. Fresh workers do not inherit this chat history; forked workers inherit it but still need a concrete task prompt.",
        args: {
          task_name: tool.schema
            .string()
            .regex(/^[a-z][a-z0-9_-]{0,31}$/)
            .describe("Task name and Herdr agent name. Use lowercase letters, digits, underscores, or hyphens."),
          message: tool.schema.string().min(1).describe("Initial task prompt for the new worker."),
          model: tool.schema
            .string()
            .optional()
            .describe("Optional OpenCode model in provider/model form."),
          reasoning_effort: tool.schema
            .string()
            .optional()
            .describe("Optional OpenCode model variant, such as low, medium, high, or max."),
          fork_current_session: tool.schema
            .boolean()
            .optional()
            .describe(
              "Fork the current OpenCode session for this worker so it inherits the conversation and tool results. Defaults to false.",
            ),
        },
        async execute(args, context) {
          return JSON.stringify(
            await agents.spawnAgent(args, context.directory, context.sessionID),
            null,
            2,
          )
        },
      }),
      prompt_herdr_worker: tool({
        description:
          "Send a prompt to an existing worker. Set interrupt=true to stop its current turn before redirecting it.",
        args: {
          target: tool.schema.string().describe("Agent id returned by spawn_herdr_worker."),
          message: tool.schema.string().min(1).describe("Prompt to send to the worker."),
          interrupt: tool.schema
            .boolean()
            .optional()
            .describe("Interrupt the current turn before sending this prompt."),
        },
        async execute(args) {
          return JSON.stringify(await agents.sendInput(args), null, 2)
        },
      }),
      wait_herdr_worker: tool({
        description:
          "Wait until one target worker settles or blocks, then return its recent terminal transcript. Returns an empty status on timeout.",
        args: {
          targets: tool.schema
            .array(tool.schema.string())
            .min(1)
            .describe("Agent ids to wait for. The call returns when the first one settles."),
          timeout_ms: tool.schema
            .number()
            .int()
            .min(1000)
            .max(3600000)
            .optional()
            .describe("Wait timeout in milliseconds. Defaults to 10000."),
        },
        async execute(args) {
          return JSON.stringify(await agents.waitAgent(args), null, 2)
        },
      }),
      close_herdr_worker: tool({
        description: "Close a worker and its Herdr tab when it is no longer needed.",
        args: {
          target: tool.schema.string().describe("Agent id returned by spawn_herdr_worker."),
        },
        async execute(args) {
          return JSON.stringify(await agents.closeAgent(args), null, 2)
        },
      }),
      list_herdr_workers: tool({
        description: "List live workers visible to Herdr, including their tab, pane, and lifecycle status.",
        args: {},
        async execute() {
          return JSON.stringify(await agents.listAgents(), null, 2)
        },
      }),
    },
  }
}
