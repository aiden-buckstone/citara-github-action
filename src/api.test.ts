import { describe, expect, it, vi } from "vitest";

import { ApiError, buildBody, describeApiError, requestScan } from "./api";
import { MAX_RETRY_AFTER_MS } from "./config";
import type { ActionInputs } from "./inputs";

const inputs: ActionInputs = {
  apiKey: "sk_live_secret",
  url: "https://example.com",
  serverUrl: "https://scan.test",
  minScore: 75,
  minGrade: "B",
  siteType: null,
  scope: null,
  commentOnPr: true,
  githubToken: null,
  timeoutMs: 10000,
  reportStyle: "technical",
  resolveLinks: true,
  agentFetch: true,
  headers: {},
  failOnError: true,
};

const okBody = {
  scanId: "s1",
  reportUrl: "https://scan.test/r",
  passed: true,
  score: 90,
  grade: "A",
  thresholds: null,
  report: {},
  markdown: { summary: "sum", prComment: "pr" },
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const err = (status: number, code: string, extra: object = {}, headers = {}) =>
  json({ error: { code, message: `msg ${code}`, ...extra } }, status, headers);

describe("buildBody", () => {
  it("omits auto site type, scope and empty headers", () => {
    const body = buildBody(inputs);
    expect(body).not.toHaveProperty("siteType");
    expect(body).not.toHaveProperty("scope");
    expect(body).not.toHaveProperty("headers");
    expect(body).toMatchObject({ url: inputs.url, minScore: 75, minGrade: "B", timeoutMs: 10000 });
  });
  it("includes them when set", () => {
    expect(buildBody({ ...inputs, siteType: "docs", scope: "page", headers: { a: "b" } })).toMatchObject({
      siteType: "docs",
      scope: "page",
      headers: { a: "b" },
    });
  });
});

describe("requestScan", () => {
  it("posts to the endpoint with a bearer token and returns the 200 body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(okBody));
    const result = await requestScan(inputs, { fetchImpl, sleep: vi.fn() });
    expect(result.score).toBe(90);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://scan.test/api/v1/scans");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer sk_live_secret");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    [401, "unauthorized"],
    [403, "domain_limit_reached"],
    [422, "invalid_request"],
    [422, "target_not_allowed"],
    [500, "internal_error"],
    [400, "other"],
  ])("does not retry %s %s", async (status, code) => {
    const fetchImpl = vi.fn().mockResolvedValue(err(status, code, { upgradeUrl: "https://scan.test/account" }));
    const sleep = vi.fn();
    await expect(requestScan(inputs, { fetchImpl, sleep })).rejects.toMatchObject({ status, code });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a 429 once, honouring Retry-After", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(err(429, "rate_limited", {}, { "retry-after": "7" }))
      .mockResolvedValueOnce(json(okBody));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(requestScan(inputs, { fetchImpl, sleep })).resolves.toMatchObject({ score: 90 });
    expect(sleep).toHaveBeenCalledWith(7000);
  });

  it("caps Retry-After at 60 s", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(err(429, "rate_limited", {}, { "retry-after": "600" }))
      .mockResolvedValueOnce(json(okBody));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await requestScan(inputs, { fetchImpl, sleep });
    expect(sleep).toHaveBeenCalledWith(MAX_RETRY_AFTER_MS);
  });

  it("gives up after a second 429", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => err(429, "rate_limited", {}, { "retry-after": "1" }));
    await expect(requestScan(inputs, { fetchImpl, sleep: vi.fn() })).rejects.toMatchObject({ code: "rate_limited" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([502, 503])("retries %s once then succeeds", async (status) => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(err(status, "service_unavailable"))
      .mockResolvedValueOnce(json(okBody));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(requestScan(inputs, { fetchImpl, sleep })).resolves.toMatchObject({ passed: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("surfaces a persistent 502 as target_unreachable", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => err(502, "target_unreachable"));
    await expect(requestScan(inputs, { fetchImpl, sleep: vi.fn() })).rejects.toMatchObject({
      code: "target_unreachable",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries a network error once and hides its cause", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("boom Bearer sk_live_secret"));
    const promise = requestScan(inputs, { fetchImpl, sleep: vi.fn() });
    await expect(promise).rejects.toMatchObject({ code: "network_error" });
    await promise.catch((e: ApiError) => expect(e.message).not.toContain("sk_live_secret"));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects an unexpected 200 body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ nope: true }));
    await expect(requestScan(inputs, { fetchImpl, sleep: vi.fn() })).rejects.toMatchObject({
      code: "bad_response",
    });
  });
});

describe("describeApiError", () => {
  const e = (code: string, extra?: string) => new ApiError("server said", 400, code, extra);
  it("maps 401", () => {
    expect(describeApiError(e("unauthorized"), "https://scan.test")).toBe(
      "Citara API key invalid, expired or revoked. Create one at https://scan.test/account/api-keys and store it as a secret.",
    );
  });
  it("includes the upgrade url for 403", () => {
    expect(describeApiError(e("domain_limit_reached", "https://scan.test/account"), "x")).toContain(
      "https://scan.test/account",
    );
  });
  it.each(["invalid_request", "target_not_allowed"])("shows the message for %s", (code) => {
    expect(describeApiError(e(code), "x")).toContain("server said");
  });
  it.each(["rate_limited", "target_unreachable", "service_unavailable", "internal_error", "network_error", "weird"])(
    "maps %s",
    (code) => {
      expect(describeApiError(e(code), "x").length).toBeGreaterThan(10);
    },
  );
});
