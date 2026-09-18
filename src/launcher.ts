import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  JobHunterClient,
  JobHunterRequestError,
  UnauthorizedError,
} from "./api/job-hunter-client.js";
import {
  AuthentikTokenProvider,
  TokenRequestError,
} from "./api/token-provider.js";
import { runCodexCanary } from "./codex/codex-probe.js";
import { loadConfig } from "./config.js";
import { CodexMaterialGenerator } from "./materials/codex-generator.js";
import { MaterialWorker } from "./materials/material-worker.js";
import { MaterialRenderer } from "./materials/renderer.js";
import { probeBrowserRunner, probeJobHunterMcp } from "./probes/mcp-probe.js";
import { runPreflight } from "./probes/preflight.js";
import { RuntimeHealthCollector } from "./runner/health-collector.js";
import { HeartbeatLoop } from "./runner/heartbeat-loop.js";
import { RunnerSessionCoordinator } from "./runner/session-coordinator.js";
import { SyntheticWorkflowWorker } from "./workflows/synthetic-workflow-worker.js";

export interface SignalSource {
  on(signal: NodeJS.Signals, handler: () => void): void;
  off(signal: NodeJS.Signals, handler: () => void): void;
}

export type LauncherStage = "config" | "health" | "materials" | "workflow";

type LauncherFailureCode =
  | "AUTH_FAILED"
  | "CONFIG_INVALID"
  | "HEALTH_FAILED"
  | "MATERIALS_FAILED"
  | "NETWORK_FAILED"
  | "UPSTREAM_REJECTED"
  | "WORKFLOW_FAILED";

interface LauncherFailureEvent {
  event: "automation_launcher_failed";
  stage: LauncherStage;
  code: LauncherFailureCode;
  status?: number;
}

class LauncherStageError extends Error {
  constructor(
    readonly stage: Exclude<LauncherStage, "config">,
    override readonly cause: unknown,
  ) {
    super("Automation launcher stage failed", { cause });
    this.name = "LauncherStageError";
  }
}

const PROCESS_SIGNALS: SignalSource = {
  on: (signal, handler) => {
    process.on(signal, handler);
  },
  off: (signal, handler) => {
    process.off(signal, handler);
  },
};

export class AutomationLauncher {
  constructor(
    private readonly run: (signal: AbortSignal) => Promise<void>,
    private readonly close: () => Promise<void>,
    private readonly signals: SignalSource = PROCESS_SIGNALS,
  ) {}

  async start(): Promise<void> {
    const controller = new AbortController();
    const stop = () => {
      controller.abort();
    };
    this.signals.on("SIGTERM", stop);
    this.signals.on("SIGINT", stop);
    const active = this.run(controller.signal);
    try {
      await Promise.race([
        active,
        aborted(controller.signal).then(() =>
          Promise.race([active, delay(SHUTDOWN_GRACE_MS)]),
        ),
      ]);
    } finally {
      controller.abort();
      await this.close();
      this.signals.off("SIGTERM", stop);
      this.signals.off("SIGINT", stop);
    }
  }
}

export function createAutomationLauncher(
  env: NodeJS.ProcessEnv = process.env,
): AutomationLauncher {
  const config = loadConfig(env);
  const tokenProvider = new AuthentikTokenProvider(config);
  const client = new JobHunterClient(config.apiUrl, tokenProvider);
  const sessions = new RunnerSessionCoordinator(client);
  const browserRunnerPath = fileURLToPath(
    new URL("./browser-runner/server.js", import.meta.url),
  );
  const collector = new RuntimeHealthCollector({
    getToken: () => tokenProvider.getAccessToken(),
    runPreflight: (token, previous, signal) =>
      runPreflight(
        {
          browserRunner: () =>
            probeBrowserRunner(
              browserRunnerPath,
              config.browserProfileDir,
              signal,
            ),
          jobHunterMcp: () =>
            probeJobHunterMcp(`${config.apiUrl}/mcp`, token, signal),
        },
        previous,
      ),
    runCodex: (token, signal) =>
      runCodexCanary(
        {
          codexHome: config.codexHome,
          workspace: CANARY_WORKSPACE,
          jobHunterMcpToken: token,
          timeoutMs: CODEX_TIMEOUT_MS,
          browserProfileDir: config.browserProfileDir,
          ...(env.DISPLAY === undefined ? {} : { display: env.DISPLAY }),
        },
        undefined,
        signal,
      ),
  });
  const loop = new HeartbeatLoop(
    client,
    (session, signal) => collector.collect(session, signal),
    undefined,
    sessions,
  );
  const materialWorker =
    config.materials === undefined
      ? undefined
      : new MaterialWorker(
          {
            workerId: config.materials.workerId,
            workRoot: config.materials.workRoot,
            pollIntervalMs: config.materials.pollIntervalMs,
            leaseHeartbeatMs: config.materials.leaseHeartbeatMs,
            baseDocxPath: config.materials.baseDocxPath,
            basePdfPath: config.materials.basePdfPath,
            profileManifestPath: config.materials.profileManifestPath,
            candidateProfilePath: config.materials.candidateProfilePath,
            factCatalogPath: config.materials.factCatalogPath,
            writingStylePath: config.materials.writingStylePath,
          },
          client,
          new CodexMaterialGenerator({
            codexHome: config.codexHome,
            outputSchemaPath: config.materials.outputSchemaPath,
            timeoutMs: config.materials.generationTimeoutMs,
          }),
          new MaterialRenderer({
            command: config.materials.rendererCommand,
            profilePath: config.materials.cvProfilePath,
            timeoutMs: config.materials.renderTimeoutMs,
          }),
        );
  const workflowWorker =
    config.workflows === undefined
      ? undefined
      : new SyntheticWorkflowWorker(config.workflows, client, sessions);
  return new AutomationLauncher(
    async (signal) => {
      await Promise.all([
        ...(config.healthReportingEnabled
          ? [runLauncherStage("health", () => loop.run(signal))]
          : []),
        ...(materialWorker === undefined
          ? []
          : [runLauncherStage("materials", () => materialWorker.run(signal))]),
        ...(workflowWorker === undefined
          ? []
          : [runLauncherStage("workflow", () => workflowWorker.run(signal))]),
      ]);
    },
    () => Promise.resolve(),
  );
}

export async function runLauncherStage(
  stage: Exclude<LauncherStage, "config">,
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    throw new LauncherStageError(stage, error);
  }
}

export async function runAutomationProcess(
  create: () => Pick<AutomationLauncher, "start"> = createAutomationLauncher,
  writeError: (line: string) => void = (line) => {
    process.stderr.write(line);
  },
): Promise<void> {
  try {
    await create().start();
  } catch (error) {
    writeError(formatLauncherFailure(error));
    throw error;
  }
}

export function formatLauncherFailure(error: unknown): string {
  return `${JSON.stringify(toLauncherFailureEvent(error))}\n`;
}

function toLauncherFailureEvent(error: unknown): LauncherFailureEvent {
  const stage =
    error instanceof LauncherStageError ? error.stage : ("config" as const);
  const cause = error instanceof LauncherStageError ? error.cause : error;
  const status = requestStatus(cause);
  if (cause instanceof UnauthorizedError || isAuthenticationStatus(status))
    return failure(stage, "AUTH_FAILED", status ?? 401);
  if (status !== undefined) return failure(stage, "UPSTREAM_REJECTED", status);
  if (isNetworkFailure(cause)) return failure(stage, "NETWORK_FAILED");
  if (stage === "config") return failure(stage, "CONFIG_INVALID");
  const code = {
    health: "HEALTH_FAILED",
    materials: "MATERIALS_FAILED",
    workflow: "WORKFLOW_FAILED",
  } as const;
  return failure(stage, code[stage]);
}

function requestStatus(error: unknown): number | undefined {
  if (
    error instanceof JobHunterRequestError ||
    error instanceof TokenRequestError
  )
    return error.status;
  return undefined;
}

function isAuthenticationStatus(status: number | undefined): boolean {
  return status === 401 || status === 403;
}

function isNetworkFailure(error: unknown): boolean {
  const networkCodes = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "ENETUNREACH",
    "ENOTFOUND",
    "ETIMEDOUT",
  ]);
  let current = error;
  for (let depth = 0; depth < 3 && current instanceof Error; depth += 1) {
    if (
      "code" in current &&
      typeof current.code === "string" &&
      networkCodes.has(current.code)
    )
      return true;
    current = current.cause;
  }
  return false;
}

function failure(
  stage: LauncherStage,
  code: LauncherFailureCode,
  status?: number,
): LauncherFailureEvent {
  return {
    event: "automation_launcher_failed",
    stage,
    code,
    ...(status === undefined ? {} : { status }),
  };
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener(
      "abort",
      () => {
        resolve();
      },
      { once: true },
    );
  });
}

const SHUTDOWN_GRACE_MS = 10_000;
const CODEX_TIMEOUT_MS = 120_000;
const CANARY_WORKSPACE = "/var/lib/job-hunter-automation/canary-workspace";

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  runAutomationProcess().catch(() => {
    process.exitCode = 1;
  });
}
