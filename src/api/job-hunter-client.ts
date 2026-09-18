import {
  AUTOMATION_STATES,
  type HeartbeatRequest,
  type HeartbeatResponse,
} from "../domain/health.js";
import {
  candidateProfileSchema,
  coverLetterPolicySchema,
  factCatalogSchema,
  materialKindSchema,
  writingStyleSchema,
  type CandidateProfile,
  type CoverLetterPolicy,
  type FactCatalog,
  type MaterialKind,
  type WritingStyle,
} from "../materials/contracts.js";
import type { TokenProvider } from "./token-provider.js";
import { z } from "zod";

export interface RunnerSession {
  runnerKey: string;
  generation: number;
  heartbeatIntervalSeconds: number;
  preflightIntervalSeconds: number;
  codexCanaryIntervalSeconds: number;
}

export const WORKFLOW_STEPS = ["PREPARE", "EXECUTE", "VERIFY"] as const;
export type WorkflowStep = (typeof WORKFLOW_STEPS)[number];

export interface WorkflowClaim {
  runId: string;
  workItemId: string;
  attemptId: string;
  leaseToken: string;
  leaseExpiresAt: string;
  generation: number;
  nextStepIndex: number;
  steps: WorkflowStep[];
}

export interface WorkflowLeaseCommand {
  attemptId: string;
  leaseToken: string;
  generation: number;
}

export interface WorkflowCheckpointCommand extends WorkflowLeaseCommand {
  idempotencyKey: string;
  step: WorkflowStep;
  evidenceSha256: string;
}

export interface WorkflowFailureCommand extends WorkflowLeaseCommand {
  retryable: boolean;
  code: string;
  detail?: string;
}

export interface WorkflowProgress {
  runId: string;
  workItemId: string;
  runStatus:
    | "QUEUED"
    | "RUNNING"
    | "PAUSED"
    | "STOPPED"
    | "SUCCEEDED"
    | "FAILED";
  workItemStatus: "QUEUED" | "LEASED" | "SUCCEEDED" | "CANCELLED" | "FAILED";
  completedSteps: number;
  leaseExpiresAt: string | null;
}

export interface MaterialClaim {
  requestId: string;
  leaseToken: string;
  leaseExpiresAt: string;
  vacancy: Record<string, unknown>;
  candidateProfile: CandidateProfile;
  factCatalog: FactCatalog;
  writingStyle: WritingStyle;
  requestedKinds: MaterialKind[];
  coverLetterPolicy: CoverLetterPolicy;
  mode: "TERRA" | "SOL_IMPROVE" | "USER_EDIT_VALIDATION";
  route: "TERRA" | "SOL_IMPROVE";
}

export interface MaterialCompletionUpload {
  status: "READY" | "READY_WITH_FALLBACK" | "BLOCKED";
  origin: "GENERATED" | "USER_EDITED" | "BASE_FALLBACK";
  generatorModel?: string;
  rendererVersion: string;
  manifest: Record<string, unknown>;
  artifacts: Partial<Record<MaterialKind, Uint8Array>>;
  artifactSha256: Partial<Record<MaterialKind, string>>;
}

export interface MaterialProfileUpload {
  manifest: Uint8Array;
  candidateProfile: Uint8Array;
  factCatalog: Uint8Array;
  writingStyle: Uint8Array;
  baseCvDocx: Uint8Array;
  baseCvPdf: Uint8Array;
}

export class UnauthorizedError extends Error {
  constructor() {
    super("Job Hunter runner authentication failed");
    this.name = "UnauthorizedError";
  }
}

export class JobHunterRequestError extends Error {
  constructor(readonly status: number) {
    super(`Job Hunter API request failed with status ${String(status)}`);
    this.name = "JobHunterRequestError";
  }
}

export class StaleGenerationError extends Error {
  constructor() {
    super("Job Hunter runner generation is stale");
    this.name = "StaleGenerationError";
  }
}

export class LeaseLostError extends Error {
  constructor() {
    super("Job Hunter workflow lease is no longer active");
    this.name = "LeaseLostError";
  }
}

export class JobHunterClient {
  constructor(
    private readonly apiUrl: string,
    private readonly tokenProvider: TokenProvider,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async startSession(): Promise<RunnerSession> {
    const response = await this.request("/automation/runner/session", {
      method: "POST",
    });
    const body: unknown = await response.json();
    if (!isRunnerSession(body))
      throw new Error("Runner session response is invalid");
    return body;
  }

  async sendHeartbeat(heartbeat: HeartbeatRequest): Promise<HeartbeatResponse> {
    const response = await this.request("/automation/runner/heartbeat", {
      method: "PUT",
      body: JSON.stringify(heartbeat),
    });
    const body: unknown = await response.json();
    if (!isHeartbeatResponse(body))
      throw new Error("Heartbeat response is invalid");
    return body;
  }

  async claimMaterial(workerId: string): Promise<MaterialClaim | null> {
    const response = await this.request("/automation/materials/claims", {
      method: "POST",
      body: JSON.stringify({ workerId }),
    });
    if (response.status === 204) return null;
    return materialClaimSchema.parse(await response.json());
  }

  async claimWorkflow(
    workerId: string,
    generation: number,
  ): Promise<WorkflowClaim | null> {
    const response = await this.request(
      "/automation/runner/work-items/claims",
      {
        method: "POST",
        body: JSON.stringify({ workerId, generation }),
      },
    );
    if (response.status === 204) return null;
    return workflowClaimSchema.parse(await response.json());
  }

  async heartbeatWorkflow(
    workItemId: string,
    command: WorkflowLeaseCommand,
  ): Promise<WorkflowProgress> {
    return this.workflowCommand(workItemId, "heartbeat", command);
  }

  async checkpointWorkflow(
    workItemId: string,
    command: WorkflowCheckpointCommand,
  ): Promise<WorkflowProgress> {
    return this.workflowCommand(workItemId, "checkpoints", command);
  }

  async completeWorkflow(
    workItemId: string,
    command: WorkflowLeaseCommand,
  ): Promise<WorkflowProgress> {
    return this.workflowCommand(workItemId, "complete", command);
  }

  async failWorkflow(
    workItemId: string,
    command: WorkflowFailureCommand,
  ): Promise<WorkflowProgress> {
    return this.workflowCommand(workItemId, "fail", command);
  }

  async importMaterialProfile(profile: MaterialProfileUpload): Promise<void> {
    const form = new FormData();
    const files: [keyof MaterialProfileUpload, string, string][] = [
      ["manifest", "manifest.json", "application/json"],
      ["candidateProfile", "candidate-profile.json", "application/json"],
      ["factCatalog", "fact-catalog.json", "application/json"],
      ["writingStyle", "writing-style.json", "application/json"],
      [
        "baseCvDocx",
        "base-cv.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ],
      ["baseCvPdf", "base-cv.pdf", "application/pdf"],
    ];
    for (const [field, filename, type] of files) {
      form.set(
        field,
        new Blob([Uint8Array.from(profile[field])], { type }),
        filename,
      );
    }
    await this.request("/automation/materials/profile", {
      method: "POST",
      body: form,
    });
  }

  async heartbeatMaterial(
    requestId: string,
    leaseToken: string,
  ): Promise<string> {
    const response = await this.request(
      `/automation/materials/${requestId}/heartbeat`,
      {
        method: "POST",
        body: JSON.stringify({ leaseToken }),
      },
    );
    return materialHeartbeatSchema.parse(await response.json()).leaseExpiresAt;
  }

  async failMaterial(
    requestId: string,
    leaseToken: string,
    reasonCode: string,
    retryable: boolean,
  ): Promise<void> {
    await this.request(`/automation/materials/${requestId}/fail`, {
      method: "POST",
      body: JSON.stringify({ leaseToken, reasonCode, retryable }),
    });
  }

  async completeMaterial(
    claim: Pick<MaterialClaim, "requestId" | "leaseToken">,
    completion: MaterialCompletionUpload,
  ): Promise<{ revisionId: string; revisionNumber: number }> {
    const form = new FormData();
    form.set(
      "metadata",
      new Blob(
        [
          JSON.stringify({
            leaseToken: claim.leaseToken,
            status: completion.status,
            origin: completion.origin,
            generatorModel: completion.generatorModel,
            rendererVersion: completion.rendererVersion,
            manifest: completion.manifest,
            artifactSha256: completion.artifactSha256,
          }),
        ],
        { type: "application/json" },
      ),
      "metadata.json",
    );
    const names: Record<MaterialKind, string> = {
      CV_DOCX: "cvDocx",
      CV_PDF: "cvPdf",
      COVER_LETTER: "coverLetter",
      RECRUITER_MESSAGE: "recruiterMessage",
    };
    for (const [kind, content] of Object.entries(completion.artifacts)) {
      const materialKind = materialKindSchema.parse(kind);
      form.set(
        names[materialKind],
        new Blob([Uint8Array.from(content)], {
          type: mediaType(materialKind),
        }),
        filename(materialKind),
      );
    }
    const response = await this.request(
      `/automation/materials/${claim.requestId}/complete`,
      { method: "POST", body: form },
    );
    return materialCompletionResponseSchema.parse(await response.json());
  }

  private async workflowCommand(
    workItemId: string,
    operation: "heartbeat" | "checkpoints" | "complete" | "fail",
    command:
      | WorkflowLeaseCommand
      | WorkflowCheckpointCommand
      | WorkflowFailureCommand,
  ): Promise<WorkflowProgress> {
    const response = await this.request(
      `/automation/runner/work-items/${workItemId}/${operation}`,
      { method: "POST", body: JSON.stringify(command) },
    );
    return workflowProgressSchema.parse(await response.json());
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const token = await this.tokenProvider.getAccessToken();
    const response = await this.fetchImplementation(
      `${this.apiUrl.replace(/\/$/, "")}${path}`,
      {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(init.body === undefined || init.body instanceof FormData
            ? {}
            : { "content-type": "application/json" }),
        },
      },
    );
    if (response.status === 401) {
      this.tokenProvider.invalidate();
      throw new UnauthorizedError();
    }
    if (response.status === 409) {
      const errorBody: unknown = await response.json().catch(() => undefined);
      if (isRecord(errorBody) && errorBody.code === "AUTOMATION_LEASE_LOST")
        throw new LeaseLostError();
      throw new StaleGenerationError();
    }
    if (!response.ok) throw new JobHunterRequestError(response.status);
    return response;
  }
}

const materialClaimSchema = z
  .object({
    requestId: z.string().uuid(),
    leaseToken: z.string().uuid(),
    leaseExpiresAt: z.string().datetime({ offset: true }),
    vacancy: z.record(z.unknown()),
    candidateProfile: candidateProfileSchema,
    factCatalog: factCatalogSchema,
    writingStyle: writingStyleSchema,
    requestedKinds: z.array(materialKindSchema),
    coverLetterPolicy: coverLetterPolicySchema,
    mode: z.enum(["TERRA", "SOL_IMPROVE", "USER_EDIT_VALIDATION"]),
    route: z.enum(["TERRA", "SOL_IMPROVE"]),
  })
  .strict();

const workflowClaimSchema = z
  .object({
    runId: z.string().uuid(),
    workItemId: z.string().uuid(),
    attemptId: z.string().uuid(),
    leaseToken: z.string().uuid(),
    leaseExpiresAt: z.string().datetime({ offset: true }),
    generation: z.number().int().positive(),
    nextStepIndex: z.number().int().min(0).max(WORKFLOW_STEPS.length),
    steps: z.array(z.enum(WORKFLOW_STEPS)).length(WORKFLOW_STEPS.length),
  })
  .strict();

const workflowProgressSchema = z
  .object({
    runId: z.string().uuid(),
    workItemId: z.string().uuid(),
    runStatus: z.enum([
      "QUEUED",
      "RUNNING",
      "PAUSED",
      "STOPPED",
      "SUCCEEDED",
      "FAILED",
    ]),
    workItemStatus: z.enum([
      "QUEUED",
      "LEASED",
      "SUCCEEDED",
      "CANCELLED",
      "FAILED",
    ]),
    completedSteps: z.number().int().min(0).max(WORKFLOW_STEPS.length),
    leaseExpiresAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

const materialHeartbeatSchema = z
  .object({ leaseExpiresAt: z.string().datetime({ offset: true }) })
  .strict();

const materialCompletionResponseSchema = z
  .object({
    revisionId: z.string().uuid(),
    revisionNumber: z.number().int().positive(),
  })
  .strict();

function mediaType(kind: MaterialKind): string {
  if (kind === "CV_PDF") return "application/pdf";
  if (kind === "CV_DOCX")
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return "text/plain";
}

function filename(kind: MaterialKind): string {
  return {
    CV_DOCX: "cv.docx",
    CV_PDF: "cv.pdf",
    COVER_LETTER: "cover-letter.txt",
    RECRUITER_MESSAGE: "recruiter-message.txt",
  }[kind];
}

function isRunnerSession(value: unknown): value is RunnerSession {
  if (!isRecord(value)) return false;
  return (
    typeof value.runnerKey === "string" &&
    isPositiveInteger(value.generation) &&
    isPositiveInteger(value.heartbeatIntervalSeconds) &&
    isPositiveInteger(value.preflightIntervalSeconds) &&
    isPositiveInteger(value.codexCanaryIntervalSeconds)
  );
}

function isHeartbeatResponse(value: unknown): value is HeartbeatResponse {
  if (!isRecord(value)) return false;
  return (
    isPositiveInteger(value.generation) &&
    isPositiveInteger(value.acceptedSequence) &&
    typeof value.overallState === "string" &&
    AUTOMATION_STATES.some((state) => state === value.overallState)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
