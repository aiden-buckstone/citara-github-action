import { beforeEach, describe, expect, it, vi } from "vitest";

const setSecret = vi.fn();
vi.mock("@actions/core", () => ({ setSecret: (v: string) => setSecret(v), getInput: vi.fn() }));

import { DEFAULT_SERVER_URL } from "./config";
import { ActionInputError, parseHeaders, readInputs } from "./inputs";

function getter(values: Record<string, string>) {
  return (name: string) => values[name] ?? "";
}

const base = { "api-key": "k", url: "https://example.com" };

describe("readInputs", () => {
  beforeEach(() => setSecret.mockClear());

  it("applies defaults and omits auto site type", () => {
    const inputs = readInputs(getter(base));
    expect(inputs).toMatchObject({
      minScore: 75,
      minGrade: "B",
      siteType: null,
      scope: null,
      commentOnPr: true,
      timeoutMs: 10000,
      reportStyle: "technical",
      resolveLinks: true,
      agentFetch: true,
      failOnError: true,
      serverUrl: DEFAULT_SERVER_URL,
      headers: {},
    });
  });

  it("parses explicit values and trims the server url", () => {
    const inputs = readInputs(
      getter({
        ...base,
        "server-url": "https://scan.test///",
        "min-score": "90",
        "min-grade": "a",
        "site-type": "Docs",
        scope: "page",
        "comment-on-pr": "false",
        "fail-on-error": "no",
        "report-style": "plain",
      }),
    );
    expect(inputs).toMatchObject({
      serverUrl: "https://scan.test",
      minScore: 90,
      minGrade: "A",
      siteType: "docs",
      scope: "page",
      commentOnPr: false,
      failOnError: false,
      reportStyle: "plain",
    });
  });

  it.each([
    ["min-score", "101"],
    ["min-score", "abc"],
    ["min-grade", "E"],
    ["site-type", "blog"],
    ["scope", "everything"],
    ["report-style", "fancy"],
    ["comment-on-pr", "maybe"],
    ["timeout", "10"],
    ["server-url", "ftp://x"],
    ["url", "example.com"],
  ])("rejects invalid %s=%s", (name, value) => {
    expect(() => readInputs(getter({ ...base, [name]: value }))).toThrow(ActionInputError);
  });

  it("requires url", () => {
    expect(() => readInputs(getter({ "api-key": "k" }))).toThrow(/url input is required/);
  });

  it("parses headers and masks their values", () => {
    const inputs = readInputs(
      getter({
        ...base,
        headers: "# comment\nx-vercel-protection-bypass: s3cret\nX-Empty:\n\nAuthorization: Bearer t: 1",
      }),
    );
    expect(inputs.headers).toEqual({
      "x-vercel-protection-bypass": "s3cret",
      Authorization: "Bearer t: 1",
    });
    expect(setSecret).toHaveBeenCalledWith("s3cret");
    expect(setSecret).toHaveBeenCalledWith("Bearer t: 1");
  });

  it("rejects malformed headers", () => {
    expect(() => parseHeaders("nocolon")).toThrow(ActionInputError);
    expect(() => parseHeaders("bad name: v")).toThrow(ActionInputError);
  });
});
