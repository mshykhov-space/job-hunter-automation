import { afterEach, describe, expect, it, vi } from "vitest";

import type { AutomationConfig } from "../../config.js";
import {
  AuthentikTokenProvider,
  TokenRequestError,
} from "../token-provider.js";

const config = {
  tokenUrl: "https://auth.example.test/token",
  m2mClientId: "client-id",
  m2mUsername: "runner",
  m2mPassword: "secret",
} satisfies Pick<
  AutomationConfig,
  "tokenUrl" | "m2mClientId" | "m2mUsername" | "m2mPassword"
>;

afterEach(() => vi.unstubAllGlobals());

describe("AuthentikTokenProvider", () => {
  it("preserves a bounded authentication status without exposing its body", async () => {
    const provider = new AuthentikTokenProvider(
      config,
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response("private identity-provider body", { status: 401 }),
        ),
    );

    await expect(provider.getAccessToken()).rejects.toMatchObject({
      name: "TokenRequestError",
      status: 401,
    } satisfies Partial<TokenRequestError>);
  });

  it("uses the exact M2M form and caches until expires_in minus 120 seconds", async () => {
    let now = 1_000_000;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Promise.resolve(
          new Response(
            JSON.stringify({ access_token: "token-one", expires_in: 300 }),
            { status: 200 },
          ),
        ),
      );
    const provider = new AuthentikTokenProvider(config, fetchMock, () => now);

    expect(await provider.getAccessToken()).toBe("token-one");
    now += 179_000;
    expect(await provider.getAccessToken()).toBe("token-one");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now += 1_001;
    await provider.getAccessToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const request = fetchMock.mock.calls[0];
    expect(request?.[0]).toBe(config.tokenUrl);
    const init = request?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeInstanceOf(URLSearchParams);
    if (!(init?.body instanceof URLSearchParams))
      throw new Error("Expected URLSearchParams request body");
    expect(init.body.toString()).toBe(
      "grant_type=client_credentials&client_id=client-id&username=runner&password=secret&scope=profile+job-hunter-api",
    );
  });

  it("clears the in-memory token explicitly", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "token-one", expires_in: 300 }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "token-two", expires_in: 300 }),
          { status: 200 },
        ),
      );
    const provider = new AuthentikTokenProvider(config, fetchMock);

    await provider.getAccessToken();
    provider.invalidate();

    expect(await provider.getAccessToken()).toBe("token-two");
  });
});
