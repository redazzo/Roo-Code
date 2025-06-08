import * as fs from "fs"
import * as path from "path"
import * as os from "node:os"

import pWaitFor from "p-wait-for"
import { execa } from "execa"

import {
	type TaskEvent,
	TaskCommandName,
	RooCodeEventName,
	IpcMessageType,
	EVALS_SETTINGS,
	EVALS_TIMEOUT,
} from "@roo-code/types"
import { IpcClient } from "@roo-code/ipc"

import { type Run, type Task, updateTask, createTaskMetrics, updateTaskMetrics, createToolError } from "../db/index.js"
import { exercisesPath } from "../exercises/index.js"

import { isDockerContainer } from "./utils.js"
import { FileLogger } from "./FileLogger.js"

class SubprocessTimeoutError extends Error {
	constructor(timeout: number) {
		super(`Subprocess timeout after ${timeout}ms`)
		this.name = "SubprocessTimeoutError"
	}
}

type RunTaskOptions = {
	run: Run
	task: Task
	publish: (taskEvent: TaskEvent) => Promise<void>
	logger: FileLogger
}

export const runTask = async ({ run, task, publish, logger }: RunTaskOptions) => {
	const { language, exercise } = task
	const prompt = fs.readFileSync(path.resolve(exercisesPath, `prompts/${language}.md`), "utf-8")
	const workspacePath = path.resolve(exercisesPath, language, exercise)
	const ipcSocketPath = path.resolve(os.tmpdir(), `evals-${run.id}-${task.id}.sock`)
	const env = { ROO_CODE_IPC_SOCKET_PATH: ipcSocketPath }
	const controller = new AbortController()
	const cancelSignal = controller.signal
	const containerized = isDockerContainer()

	const codeCommand = containerized
		? `xvfb-run --auto-servernum --server-num=1 code --wait --log trace --disable-workspace-trust --disable-gpu --disable-lcd-text --no-sandbox --user-data-dir /roo/.vscode --password-store="basic" -n ${workspacePath}`
		: `code --disable-workspace-trust -n ${workspacePath}`

	logger.info(codeCommand)

	// Sleep for a random amount of time between 5 and 10 seconds, unless we're
	// running in a container, in which case there are no issues with flooding
	// VSCode with new windows.
	if (!containerized) {
		await new Promise((resolve) => setTimeout(resolve, Math.random() * 5_000 + 5_000))
	}

	const subprocess = execa({ env, shell: "/bin/bash", cancelSignal })`${codeCommand}`

	// If debugging, add `--verbose` to `command` and uncomment the following line.
	// subprocess.stdout.pipe(process.stdout)

	// Give VSCode some time to spawn before connecting to its unix socket.
	await new Promise((resolve) => setTimeout(resolve, 3_000))
	let client: IpcClient | undefined = undefined
	let attempts = 5

	while (true) {
		try {
			client = new IpcClient(ipcSocketPath)
			await pWaitFor(() => client!.isReady, { interval: 250, timeout: 1_000 })
			break
		} catch (_error) {
			client?.disconnect()
			attempts--

			if (attempts <= 0) {
				logger.error(`unable to connect to IPC socket -> ${ipcSocketPath}`)
				throw new Error("Unable to connect.")
			}
		}
	}

	let taskStartedAt = Date.now()
	let taskFinishedAt: number | undefined
	let taskMetricsId: number | undefined
	let rooTaskId: string | undefined
	let isClientDisconnected = false

	const ignoreEvents: Record<"broadcast" | "log", RooCodeEventName[]> = {
		broadcast: [RooCodeEventName.Message],
		log: [RooCodeEventName.TaskTokenUsageUpdated, RooCodeEventName.TaskAskResponded],
	}

	client.on(IpcMessageType.TaskEvent, async (taskEvent) => {
		const { eventName, payload } = taskEvent

		// Publish all events except for these to Redis.
		if (!ignoreEvents.broadcast.includes(eventName)) {
			await publish({ ...taskEvent, taskId: task.id })
		}

		// Log all events except for these.
		// For message events we only log non-partial messages.
		if (
			!ignoreEvents.log.includes(eventName) &&
			(eventName !== RooCodeEventName.Message || payload[0].message.partial !== true)
		) {
			logger.info(`${eventName} ->`, payload)
		}

		if (eventName === RooCodeEventName.TaskStarted) {
			taskStartedAt = Date.now()

			const taskMetrics = await createTaskMetrics({
				cost: 0,
				tokensIn: 0,
				tokensOut: 0,
				tokensContext: 0,
				duration: 0,
				cacheWrites: 0,
				cacheReads: 0,
			})

			await updateTask(task.id, { taskMetricsId: taskMetrics.id, startedAt: new Date() })

			taskStartedAt = Date.now()
			taskMetricsId = taskMetrics.id
			rooTaskId = payload[0]
		}

		if (eventName === RooCodeEventName.TaskToolFailed) {
			const [_taskId, toolName, error] = payload
			await createToolError({ taskId: task.id, toolName, error })
		}

		if (
			(eventName === RooCodeEventName.TaskTokenUsageUpdated || eventName === RooCodeEventName.TaskCompleted) &&
			taskMetricsId
		) {
			const duration = Date.now() - taskStartedAt

			const { totalCost, totalTokensIn, totalTokensOut, contextTokens, totalCacheWrites, totalCacheReads } =
				payload[1]

			await updateTaskMetrics(taskMetricsId, {
				cost: totalCost,
				tokensIn: totalTokensIn,
				tokensOut: totalTokensOut,
				tokensContext: contextTokens,
				duration,
				cacheWrites: totalCacheWrites ?? 0,
				cacheReads: totalCacheReads ?? 0,
			})
		}

		if (eventName === RooCodeEventName.TaskCompleted && taskMetricsId) {
			const toolUsage = payload[2]
			await updateTaskMetrics(taskMetricsId, { toolUsage })
		}

		if (eventName === RooCodeEventName.TaskAborted || eventName === RooCodeEventName.TaskCompleted) {
			taskFinishedAt = Date.now()
			await updateTask(task.id, { finishedAt: new Date() })
		}
	})

	client.on(IpcMessageType.Disconnect, async () => {
		logger.info(`disconnected from IPC socket -> ${ipcSocketPath}`)
		isClientDisconnected = true
	})

	client.sendCommand({
		commandName: TaskCommandName.StartNewTask,
		data: {
			configuration: {
				...EVALS_SETTINGS,
				...run.settings,
				openRouterApiKey: process.env.OPENROUTER_API_KEY,
			},
			text: prompt,
			newTab: true,
		},
	})

	try {
		await pWaitFor(() => !!taskFinishedAt || isClientDisconnected, { interval: 1_000, timeout: EVALS_TIMEOUT })
	} catch (_error) {
		logger.error("time limit reached")

		if (rooTaskId && !isClientDisconnected) {
			logger.info("cancelling task")
			client.sendCommand({ commandName: TaskCommandName.CancelTask, data: rooTaskId })
			await new Promise((resolve) => setTimeout(resolve, 5_000)) // Allow some time for the task to cancel.
		}

		await updateTask(task.id, { finishedAt: new Date() })
	}

	if (isClientDisconnected) {
		logger.error("client disconnected before task finished")
	} else {
		if (rooTaskId) {
			logger.info("closing task")
			client.sendCommand({ commandName: TaskCommandName.CloseTask, data: rooTaskId })
			await new Promise((resolve) => setTimeout(resolve, 2_000)) // Allow some time for the window to close.
		}

		client.disconnect()
	}

	logger.info("waiting for subprocess to finish")
	controller.abort()

	// Wait for subprocess to finish gracefully, with a timeout.
	const SUBPROCESS_TIMEOUT = 10_000

	try {
		await Promise.race([
			subprocess,
			new Promise((_, reject) =>
				setTimeout(() => reject(new SubprocessTimeoutError(SUBPROCESS_TIMEOUT)), SUBPROCESS_TIMEOUT),
			),
		])

		logger.info("subprocess finished gracefully")
	} catch (error) {
		if (error instanceof SubprocessTimeoutError) {
			logger.error("subprocess did not finish within timeout, force killing")

			try {
				if (subprocess.kill("SIGKILL")) {
					logger.info("SIGKILL sent to subprocess")
				} else {
					logger.error("failed to send SIGKILL to subprocess")
				}
			} catch (killError) {
				logger.error("subprocess.kill(SIGKILL) failed:", killError)
			}
		} else {
			throw error
		}
	}

	logger.close()
}
