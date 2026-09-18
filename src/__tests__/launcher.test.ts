import { describe, expect, it, vi } from "vitest";

import {
  JobHunterRequestError,
  UnauthorizedError,
} from "../api/job-hunter-client.js";
import {
  AutomationLauncher,
  formatLauncherFailure,
  runAutomationProcess,
  runLauncherStage,
  type SignalSource,
} from "../launcher.js";

describe("AutomationLauncher", () => {
  it("stops scheduling on SIGTERM and closes runtime resources", async () => {
    const handlers = new Map<NodeJS.Signals, () => void>();
    const on = vi.fn<SignalSource["on"]>((signal, handler) => {
      handlers.set(signal, handler);
    });
    const off = vi.fn<SignalSource["off"]>((signal) => {
      handlers.delete(signal);
    });
    const signals: SignalSource = {
      on,
      off,
    };
    const run = vi.fn(
      (signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", resolve, { once: true });
        }),
    );
    const close = vi.fn(() => Promise.resolve());
    const launcher = new AutomationLauncher(run, close, signals);

    const active = launcher.start();
    handlers.get("SIGTERM")?.();
    await active;

    expect(run.mock.calls[0]?.[0].aborted).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(off).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["health", "HEALTH_FAILED"],
    ["materials", "MATERIALS_FAILED"],
    ["workflow", "WORKFLOW_FAILED"],
  ] as const)("identifies a failed %s boundary", async (stage, code) => {
    const failure = runLauncherStage(stage, () =>
      Promise.reject(new Error("token=private command output")),
    );

    await expect(failure).rejects.toSatisfy((error: unknown) => {
      expect(formatLauncherFailure(error)).toBe(
        `${JSON.stringify({ event: "automation_launcher_failed", stage, code })}\n`,
      );
      return true;
    });
  });

  it("reports authentication status without serializing the exception", async () => {
    const failure = runLauncherStage("health", () =>
      Promise.reject(new UnauthorizedError()),
    );

    await expect(failure).rejects.toSatisfy((error: unknown) => {
      expect(formatLauncherFailure(error)).toBe(
        '{"event":"automation_launcher_failed","stage":"health","code":"AUTH_FAILED","status":401}\n',
      );
      return true;
    });
  });

  it("reports a bounded upstream status at its failing boundary", async () => {
    const failure = runLauncherStage("materials", () =>
      Promise.reject(new JobHunterRequestError(503)),
    );

    await expect(failure).rejects.toSatisfy((error: unknown) => {
      expect(formatLauncherFailure(error)).toBe(
        '{"event":"automation_launcher_failed","stage":"materials","code":"UPSTREAM_REJECTED","status":503}\n',
      );
      return true;
    });
  });

  it("reports network failures without serializing nested command output", async () => {
    const cause = Object.assign(new Error("authorization: Bearer private"), {
      code: "ECONNREFUSED",
      body: "private response body",
    });
    const failure = runLauncherStage("workflow", () =>
      Promise.reject(new TypeError("fetch failed", { cause })),
    );

    await expect(failure).rejects.toSatisfy((error: unknown) => {
      const line = formatLauncherFailure(error);
      expect(line).toBe(
        '{"event":"automation_launcher_failed","stage":"workflow","code":"NETWORK_FAILED"}\n',
      );
      expect(line).not.toContain("private");
      expect(line).not.toContain("Bearer");
      return true;
    });
  });

  it("catches synchronous configuration failures at the process boundary", async () => {
    const write = vi.fn<(line: string) => void>();
    const secret = "super-secret-password";

    await expect(
      runAutomationProcess(() => {
        throw new Error(`Invalid config: ${secret}`);
      }, write),
    ).rejects.toThrow();

    expect(write).toHaveBeenCalledWith(
      '{"event":"automation_launcher_failed","stage":"config","code":"CONFIG_INVALID"}\n',
    );
    expect(write.mock.calls.flat().join(" ")).not.toContain(secret);
  });
});
