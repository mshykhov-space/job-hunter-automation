import { afterEach, describe, expect, it, vi } from "vitest";

import type { HeartbeatRequest } from "../../domain/health.js";
import { validGenerationInput } from "../../materials/__tests__/fixtures.js";
import {
  JobHunterClient,
  JobHunterRequestError,
  LeaseLostError,
  StaleGenerationError,
  UnauthorizedError,
} from "../job-hunter-client.js";
import type { TokenProvider } from "../token-provider.js";

const tokenProvider = {
  getAccessToken: vi.fn(() => Promise.resolve("access-token")),
  invalidate: vi.fn(),
} satisfies TokenProvider;

const heartbeat: HeartbeatRequest = {
  generation: 3,
  sequence: 1,
  idempotencyKey: "d07cb2ae-3b18-46d4-8c2d-aeaaf3bbce1f",
  sentAt: "2026-08-18T08:00:00Z",
  launcherVersion: "0.1.0",
  components: {},
  probes: {},
  codexInputTokens: 0,
  codexOutputTokens: 0,
};

afterEach(() => vi.clearAllMocks());

describe("JobHunterClient", () => {
  it("starts a typed runner session", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          runnerKey: "primary",
          generation: 7,
          heartbeatIntervalSeconds: 60,
          preflightIntervalSeconds: 300,
          codexCanaryIntervalSeconds: 21_600,
        }),
        { status: 200 },
      ),
    );
    const client = new JobHunterClient(
      "https://api.example.test",
      tokenProvider,
      fetchMock,
    );

    await expect(client.startSession()).resolves.toMatchObject({
      generation: 7,
      runnerKey: "primary",
    });
    const request = fetchMock.mock.calls[0];
    expect(request?.[0]).toBe(
      "https://api.example.test/automation/runner/session",
    );
    expect(request?.[1]?.method).toBe("POST");
    expect(new Headers(request?.[1]?.headers).get("authorization")).toBe(
      "Bearer access-token",
    );
  });

  it("invalidates the token cache on 401", async () => {
    const client = new JobHunterClient(
      "https://api.example.test",
      tokenProvider,
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 401 })),
    );

    await expect(client.sendHeartbeat(heartbeat)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(tokenProvider.invalidate).toHaveBeenCalledOnce();
  });

  it("preserves a bounded upstream status without exposing its body", async () => {
    const client = new JobHunterClient(
      "https://api.example.test",
      tokenProvider,
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response("private response body", { status: 503 }),
        ),
    );

    const failure = client.sendHeartbeat(heartbeat);

    await expect(failure).rejects.toMatchObject({
      name: "JobHunterRequestError",
      status: 503,
    } satisfies Partial<JobHunterRequestError>);
    await expect(failure).rejects.not.toThrow(/private response body/);
  });

  it("maps a conflict to stale generation without exposing response content", async () => {
    const client = new JobHunterClient(
      "https://api.example.test",
      tokenProvider,
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("internal details", { status: 409 })),
    );

    await expect(client.sendHeartbeat(heartbeat)).rejects.toBeInstanceOf(
      StaleGenerationError,
    );
  });

  it("accepts the API heartbeat response contract", async () => {
    const client = new JobHunterClient(
      "https://api.example.test",
      tokenProvider,
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            generation: 3,
            acceptedSequence: 1,
            overallState: "READY",
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(client.sendHeartbeat(heartbeat)).resolves.toMatchObject({
      acceptedSequence: 1,
      overallState: "READY",
    });
  });

  it("returns null when no material request is queued", async () => {
    const client = new JobHunterClient(
      "https://api.example.test",
      tokenProvider,
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 204 })),
    );

    await expect(client.claimMaterial("local-runner")).resolves.toBeNull();
  });

  it("claims a typed synthetic workflow", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          runId: "d07cb2ae-3b18-46d4-8c2d-aeaaf3bbce1f",
          workItemId: "d07cb2ae-3b18-46d4-8c2d-aeaaf3bbce2f",
          attemptId: "d07cb2ae-3b18-46d4-8c2d-aeaaf3bbce3f",
          leaseToken: "d07cb2ae-3b18-46d4-8c2d-aeaaf3bbce4f",
          leaseExpiresAt: "2026-09-04T09:00:00Z",
          generation: 7,
          nextStepIndex: 1,
          steps: ["PREPARE", "EXECUTE", "VERIFY"],
        }),
        { status: 200 },
      ),
    );
    const client = new JobHunterClient(
      "https://api.example.test",
      tokenProvider,
      fetchMock,
    );

    await expect(client.claimWorkflow("worker", 7)).resolves.toMatchObject({
      generation: 7,
      nextStepIndex: 1,
    });
  });

  it("distinguishes a revoked workflow lease from stale generation", async () => {
    const client = new JobHunterClient(
      "https://api.example.test",
      tokenProvider,
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            message: "Automation work lease is stale or invalid",
            code: "AUTOMATION_LEASE_LOST",
          }),
          { status: 409 },
        ),
      ),
    );

    await expect(
      client.heartbeatWorkflow("d07cb2ae-3b18-46d4-8c2d-aeaaf3bbce2f", {
        attemptId: "d07cb2ae-3b18-46d4-8c2d-aeaaf3bbce3f",
        leaseToken: "d07cb2ae-3b18-46d4-8c2d-aeaaf3bbce4f",
        generation: 7,
      }),
    ).rejects.toBeInstanceOf(LeaseLostError);
  });

  it("uploads completion as multipart without overriding its boundary", async () => {
    const input = validGenerationInput();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          revisionId: "d07cb2ae-3b18-46d4-8c2d-aeaaf3bbce2f",
          revisionNumber: 1,
        }),
        { status: 200 },
      ),
    );
    const client = new JobHunterClient(
      "https://api.example.test",
      tokenProvider,
      fetchMock,
    );

    await client.completeMaterial(
      {
        requestId: input.requestId,
        leaseToken: "d07cb2ae-3b18-46d4-8c2d-aeaaf3bbce3f",
      },
      {
        status: "READY",
        origin: "GENERATED",
        generatorModel: "gpt-5.6-terra",
        rendererVersion: "cv-materials/test",
        manifest: { pageCount: 2 },
        artifacts: { CV_PDF: Buffer.from("pdf") },
        artifactSha256: { CV_PDF: "a".repeat(64) },
      },
    );

    const request = fetchMock.mock.calls[0]?.[1];
    expect(request?.body).toBeInstanceOf(FormData);
    expect(new Headers(request?.headers).has("content-type")).toBe(false);
  });

  it("imports the immutable candidate profile bundle as multipart", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "d07cb2ae-3b18-46d4-8c2d-aeaaf3bbce2f",
          profileVersion: "a".repeat(64),
          schemaVersion: "application-materials/v1",
          sourceCommit: "b".repeat(40),
          active: true,
          createdAt: null,
        }),
        { status: 200 },
      ),
    );
    const client = new JobHunterClient(
      "https://api.example.test",
      tokenProvider,
      fetchMock,
    );

    await client.importMaterialProfile({
      manifest: Buffer.from("manifest"),
      candidateProfile: Buffer.from("profile"),
      factCatalog: Buffer.from("facts"),
      writingStyle: Buffer.from("style"),
      baseCvDocx: Buffer.from("docx"),
      baseCvPdf: Buffer.from("pdf"),
    });

    const request = fetchMock.mock.calls[0];
    expect(request?.[0]).toBe(
      "https://api.example.test/automation/materials/profile",
    );
    const form = request?.[1]?.body;
    expect(form).toBeInstanceOf(FormData);
    expect([...(form as FormData).keys()].sort()).toEqual([
      "baseCvDocx",
      "baseCvPdf",
      "candidateProfile",
      "factCatalog",
      "manifest",
      "writingStyle",
    ]);
  });
});
