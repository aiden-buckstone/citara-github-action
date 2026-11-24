import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({
  setSecret: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  getInput: vi.fn(),
  summary: { addRaw: vi.fn(), write: vi.fn() },
}));
vi.mock("@actions/core", () => core);

import { MARKER } from "./config";
import { run } from "./main";

const KEY = "sk_live_topsecret";

const okBody = (over: Record<string, unknown> = {}) => ({
  scanId: "scan-1",
  reportUrl: "https://scan.test/account/reports/d/scan-1",
  passed: true,
  score: 92,
  grade: "A",
  thresholds: { minScore: 75, minGrade: "B", scorePassed: true, gradePassed: true },
  report: { tier: "full" },
  markdown: { summary: `<!-- ${MARKER} -->\n\n## Summary`, prComment: `<!-- ${MARKER} -->\n\n## PR` },
  plan: { id: "pro", redacted: false },
  ...over,
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

const inputValues: Record<string, string> = {
  "api-key": KEY,
  url: "https://example.com",
  "server-url": "https://scan.test",
  "github-token": "ghs_token",
  headers: "x-bypass: hdrsecret",
};
const getInput = (overrides: Record<string, string> = {}) => (name: string) =>
  ({ ...inputValues, ...overrides })[name] ?? "";

function prEnv(extra: Record<string, string> = {}) {
  return {
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: "/event.json",
    GITHUB_REPOSITORY: "o/r",
    ...extra,
  };
}

// Event file is read via node:fs; stub it.
vi.mock("node:fs", async (orig) => {
  const actual = await orig<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (path: string, ...rest: unknown[]) =>
      path === "/event.json"
        ? (globalThis as { __event?: string }).__event ?? "{}"
        : (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest),
  };
});
function setEvent(event: unknown) {
  (globalThis as { __event?: string }).__event = JSON.stringify(event);
}

/** Routes the scan call and the GitHub comment calls. */
function router(scan: () => Response, comments: Array<{ id: number; body: string }> = []) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body as string | undefined });
    if (url.endsWith("/api/v1/scans")) return scan();
    if (init.method === "POST") return json({ html_url: "https://gh/c/1" }, 201);
    if (init.method === "PATCH") return json({ html_url: "https://gh/c/9" });
    return json(comments);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const sleep = vi.fn().mockResolvedValue(undefined);

function allLogged(): string {
  return JSON.stringify([
    core.info.mock.calls,
    core.warning.mock.calls,
    core.setFailed.mock.calls,
    core.setOutput.mock.calls,
    core.summary.addRaw.mock.calls,
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  core.summary.addRaw.mockReturnThis();
  core.summary.write.mockResolvedValue(undefined);
  setEvent({ pull_request: { number: 7, head: { repo: { fork: false, full_name: "o/r" } } } });
});

describe("run: success paths", () => {
  it("masks the key first, sets outputs and posts a new sticky comment on a pass", async () => {
    const { fetchImpl, calls } = router(() => json(okBody()));
    await run({ getInput: getInput(), env: prEnv(), fetchImpl, sleep });

    expect(core.setSecret.mock.invocationCallOrder[0]).toBeLessThan(
      core.info.mock.invocationCallOrder[0]!,
    );
    expect(core.setSecret).toHaveBeenCalledWith(KEY);
    expect(core.setSecret).toHaveBeenCalledWith("hdrsecret");

    expect(core.setOutput).toHaveBeenCalledWith("score", "92");
    expect(core.setOutput).toHaveBeenCalledWith("grade", "A");
    expect(core.setOutput).toHaveBeenCalledWith("passed", "true");
    expect(core.setOutput).toHaveBeenCalledWith("report-url", "https://scan.test/account/reports/d/scan-1");
    expect(core.setOutput).toHaveBeenCalledWith("scan-id", "scan-1");
    expect(core.setOutput).toHaveBeenCalledWith("report-json", JSON.stringify({ tier: "full" }));
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.summary.addRaw.mock.calls[0]![0]).toBe("## Summary\n");
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining("92"));

    const post = calls.find((c) => c.method === "POST" && c.url.includes("/issues/7/comments"));
    expect(post).toBeTruthy();
    expect(JSON.parse(post!.body!).body).toContain(MARKER);
  });

  it("adds the marker when the server markdown lacks it", async () => {
    const { fetchImpl, calls } = router(() =>
      json(okBody({ markdown: { summary: "s", prComment: "plain body" } })),
    );
    await run({ getInput: getInput(), env: prEnv(), fetchImpl, sleep });
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/comments"));
    expect(JSON.parse(post!.body!).body).toContain(`<!-- ${MARKER} -->`);
  });

  it("updates the existing sticky comment instead of creating another", async () => {
    const { fetchImpl, calls } = router(() => json(okBody()), [
      { id: 3, body: "other" },
      { id: 9, body: `<!-- ${MARKER} -->\nold` },
    ]);
    await run({ getInput: getInput(), env: prEnv(), fetchImpl, sleep });
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toContain("/issues/comments/9");
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/issues/7/comments"))).toBe(false);
  });

  it("skips the comment when comment-on-pr is false or the event is a push", async () => {
    const a = router(() => json(okBody()));
    await run({ getInput: getInput({ "comment-on-pr": "false" }), env: prEnv(), fetchImpl: a.fetchImpl, sleep });
    expect(a.calls).toHaveLength(1);

    setEvent({ ref: "refs/heads/main" });
    const b = router(() => json(okBody()));
    await run({ getInput: getInput(), env: prEnv({ GITHUB_EVENT_NAME: "push" }), fetchImpl: b.fetchImpl, sleep });
    expect(b.calls).toHaveLength(1);
  });

  it("warns, not fails, when the comment cannot be written", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith("/api/v1/scans") ? json(okBody()) : new Response("no", { status: 403 }),
    ) as unknown as typeof fetch;
    await run({ getInput: getInput(), env: prEnv(), fetchImpl, sleep });
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("Could not write the pull request comment"));
    expect(core.setFailed).not.toHaveBeenCalled();
  });
});

describe("run: failed gate", () => {
  it("sets outputs, comments, then fails with score and grade vs thresholds", async () => {
    const body = okBody({
      passed: false,
      score: 60,
      grade: "D",
      thresholds: { minScore: 75, minGrade: "B", scorePassed: false, gradePassed: false },
    });
    const { fetchImpl, calls } = router(() => json(body));
    await run({ getInput: getInput(), env: prEnv(), fetchImpl, sleep });
    expect(core.setOutput).toHaveBeenCalledWith("passed", "false");
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/comments"))).toBe(true);
    expect(core.setFailed).toHaveBeenCalledWith(
      "Citara gate failed: score 60 < 75, grade D < B",
    );
  });

  it("still fails the gate when fail-on-error is false", async () => {
    const { fetchImpl } = router(() => json(okBody({ passed: false, thresholds: null })));
    await run({ getInput: getInput({ "fail-on-error": "false" }), env: prEnv(), fetchImpl, sleep });
    expect(core.setFailed).toHaveBeenCalled();
  });
});

describe("run: API errors", () => {
  const cases: Array<[number, string, object, string]> = [
    [401, "unauthorized", {}, "https://scan.test/account/api-keys"],
    [403, "domain_limit_reached", { upgradeUrl: "https://scan.test/account" }, "https://scan.test/account"],
    [422, "invalid_request", {}, "bad thing"],
    [422, "target_not_allowed", {}, "bad thing"],
    [429, "rate_limited", {}, "Rate limited"],
    [502, "target_unreachable", {}, "could not reach the target"],
    [503, "service_unavailable", {}, "temporarily unavailable"],
    [500, "internal_error", {}, "internal error"],
  ];

  it.each(cases)("%s %s fails the job with an actionable message", async (status, code, extra, expected) => {
    const { fetchImpl } = router(() =>
      json({ error: { code, message: "bad thing", ...extra } }, status, { "retry-after": "1" }),
    );
    await run({ getInput: getInput(), env: prEnv(), fetchImpl, sleep });
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining(expected));
    expect(core.setOutput).toHaveBeenCalledWith("passed", "false");
    expect(allLogged()).not.toContain(KEY);
  });

  it("only warns when fail-on-error is false", async () => {
    const { fetchImpl } = router(() => json({ error: { code: "unauthorized", message: "x" } }, 401));
    await run({ getInput: getInput({ "fail-on-error": "false" }), env: prEnv(), fetchImpl, sleep });
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("API key invalid"));
  });

  it("handles a network failure after the retry", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error(`socket ${KEY}`)) as unknown as typeof fetch;
    await run({ getInput: getInput(), env: prEnv(), fetchImpl, sleep });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining("Could not reach"));
    expect(allLogged()).not.toContain(KEY);
  });

  it("fails on invalid inputs even with fail-on-error false", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await run({
      getInput: getInput({ "min-score": "500", "fail-on-error": "false" }),
      env: prEnv(),
      fetchImpl,
    });
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining("min-score"));
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("run: missing api key", () => {
  it("warns and succeeds for a pull request from a fork", async () => {
    setEvent({ pull_request: { number: 7, head: { repo: { fork: true, full_name: "x/r" } } } });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await run({ getInput: getInput({ "api-key": "" }), env: prEnv(), fetchImpl, sleep });
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("forks"));
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.setSecret).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails otherwise", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await run({ getInput: getInput({ "api-key": "" }), env: prEnv(), fetchImpl, sleep });
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining("api-key"));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails for a same-repo pull request with an empty key", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await run({ getInput: getInput({ "api-key": " " }), env: prEnv(), fetchImpl, sleep });
    expect(core.setFailed).toHaveBeenCalled();
  });
});

describe("secret handling", () => {
  it("never logs the key or header values on success", async () => {
    const { fetchImpl } = router(() => json(okBody()));
    await run({ getInput: getInput(), env: prEnv(), fetchImpl, sleep });
    const logged = allLogged();
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain("hdrsecret");
  });
});
