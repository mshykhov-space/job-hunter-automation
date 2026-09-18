import type { AutomationConfig } from "../config.js";

type TokenConfig = Pick<
  AutomationConfig,
  "tokenUrl" | "m2mClientId" | "m2mUsername" | "m2mPassword"
>;

export interface TokenProvider {
  getAccessToken(): Promise<string>;
  invalidate(): void;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

export class TokenRequestError extends Error {
  constructor(readonly status: number) {
    super(`M2M token request failed with status ${String(status)}`);
    this.name = "TokenRequestError";
  }
}

export class AuthentikTokenProvider implements TokenProvider {
  private cached: CachedToken | undefined;
  private acquisition: Promise<CachedToken> | undefined;

  constructor(
    private readonly config: TokenConfig,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async getAccessToken(): Promise<string> {
    if (this.cached && this.now() < this.cached.expiresAt)
      return this.cached.value;
    this.acquisition ??= this.acquire();
    try {
      this.cached = await this.acquisition;
      return this.cached.value;
    } finally {
      this.acquisition = undefined;
    }
  }

  invalidate(): void {
    this.cached = undefined;
  }

  private async acquire(): Promise<CachedToken> {
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.config.m2mClientId,
      username: this.config.m2mUsername,
      password: this.config.m2mPassword,
      scope: "profile job-hunter-api",
    });
    const response = await this.fetchImplementation(this.config.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    if (!response.ok) throw new TokenRequestError(response.status);
    const body: unknown = await response.json();
    if (!isTokenResponse(body))
      throw new Error("M2M token response is invalid");
    const cacheSeconds = Math.max(
      0,
      body.expires_in - TOKEN_EXPIRY_MARGIN_SECONDS,
    );
    return {
      value: body.access_token,
      expiresAt: this.now() + cacheSeconds * 1000,
    };
  }
}

function isTokenResponse(
  value: unknown,
): value is { access_token: string; expires_in: number } {
  if (typeof value !== "object" || value === null) return false;
  return (
    "access_token" in value &&
    typeof value.access_token === "string" &&
    value.access_token.length > 0 &&
    "expires_in" in value &&
    typeof value.expires_in === "number" &&
    Number.isFinite(value.expires_in) &&
    value.expires_in > 0
  );
}

const TOKEN_EXPIRY_MARGIN_SECONDS = 120;
