import * as core from "@actions/core";

import { DEFAULT_SERVER_URL } from "./config";

export const SITE_TYPES = [
  "saas",
  "portfolio",
  "docs",
  "ecommerce",
  "local-business",
  "blog-media",
] as const;
export const GRADES = ["A", "B", "C", "D", "F"] as const;
export const REPORT_STYLES = ["technical", "plain"] as const;

export interface ActionInputs {
  apiKey: string;
  url: string;
  serverUrl: string;
  minScore: number;
  minGrade: string;
  /** null means auto: the field is omitted from the request body. */
  siteType: string | null;
  scope: "site" | "page" | null;
  commentOnPr: boolean;
  githubToken: string | null;
  timeoutMs: number;
  reportStyle: "technical" | "plain";
  resolveLinks: boolean;
  agentFetch: boolean;
  headers: Record<string, string>;
  failOnError: boolean;
}

export class ActionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionInputError";
  }
}

export type InputGetter = (name: string) => string;

function parseInteger(value: string, name: string, min: number, max: number): number {
  const parsed = Number(value);
  if (value === "" || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ActionInputError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function parseBoolean(value: string, name: string): boolean {
  const normalized = value.toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  throw new ActionInputError(`${name} must be true or false.`);
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export function parseHeaders(value: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf(":");
    if (separator === -1) {
      throw new ActionInputError("headers must use one “Name: value” entry per line.");
    }

    const name = trimmed.slice(0, separator).trim();
    const headerValue = trimmed.slice(separator + 1).trim();
    if (!HEADER_NAME.test(name)) {
      throw new ActionInputError(`headers contains an invalid name: “${name}”.`);
    }
    // An empty value lets a workflow pass an optional secret without
    // constructing conditional input strings.
    if (!headerValue) continue;
    headers[name] = headerValue;
  }
  return headers;
}

/**
 * Reads and validates every input. The caller masks the API key before this
 * runs, and header values are masked here as soon as they are parsed.
 */
export function readInputs(get: InputGetter = (name) => core.getInput(name)): ActionInputs {
  const read = (name: string) => get(name).trim();

  const url = read("url");
  if (!url) throw new ActionInputError("The url input is required.");
  if (!/^https?:\/\//i.test(url)) {
    throw new ActionInputError("url must start with http:// or https://.");
  }

  const serverUrl = (read("server-url") || DEFAULT_SERVER_URL).replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(serverUrl)) {
    throw new ActionInputError("server-url must start with http:// or https://.");
  }

  const minScore = parseInteger(read("min-score") || "75", "min-score", 0, 100);
  const minGrade = (read("min-grade") || "B").toUpperCase();
  if (!(GRADES as readonly string[]).includes(minGrade)) {
    throw new ActionInputError("min-grade must be one of A, B, C, D or F.");
  }

  const siteTypeValue = (read("site-type") || "auto").toLowerCase();
  let siteType: string | null = null;
  if (siteTypeValue !== "auto") {
    if (!(SITE_TYPES as readonly string[]).includes(siteTypeValue)) {
      throw new ActionInputError(
        "site-type must be auto, saas, portfolio, docs, ecommerce, local-business or blog-media.",
      );
    }
    siteType = siteTypeValue;
  }

  const scopeValue = read("scope").toLowerCase();
  let scope: "site" | "page" | null = null;
  if (scopeValue) {
    if (scopeValue !== "site" && scopeValue !== "page") {
      throw new ActionInputError("scope must be site or page.");
    }
    scope = scopeValue;
  }

  const reportStyle = (read("report-style") || "technical").toLowerCase();
  if (!(REPORT_STYLES as readonly string[]).includes(reportStyle)) {
    throw new ActionInputError("report-style must be technical or plain.");
  }

  const headers = parseHeaders(get("headers"));
  for (const value of Object.values(headers)) core.setSecret(value);

  return {
    apiKey: read("api-key"),
    url,
    serverUrl,
    minScore,
    minGrade,
    siteType,
    scope,
    commentOnPr: parseBoolean(read("comment-on-pr") || "true", "comment-on-pr"),
    githubToken: read("github-token") || null,
    timeoutMs: parseInteger(read("timeout") || "10000", "timeout", 1000, 120000),
    reportStyle: reportStyle as "technical" | "plain",
    resolveLinks: parseBoolean(read("resolve-links") || "true", "resolve-links"),
    agentFetch: parseBoolean(read("agent-fetch") || "true", "agent-fetch"),
    headers,
    failOnError: parseBoolean(read("fail-on-error") || "true", "fail-on-error"),
  };
}
