import {
  DEFAULT_RETRY_AFTER_MS,
  MAX_RETRY_AFTER_MS,
  REQUEST_TIMEOUT_MS,
  RETRY_BACKOFF_MS,
  USER_AGENT,
} from "./config";
import type { ActionInputs } from "./inputs";

export interface ScanResponse {
  scanId: string;
  reportUrl: string;
  passed: boolean;
  score: number;
  grade: string;
  thresholds?: {
    minScore: number;
    minGrade: string;
    scorePassed: boolean;
    gradePassed: boolean;
  } | null;
  report: unknown;
  markdown: { summary: string; prComment: string };
  plan?: { id: string; redacted: boolean };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string,
    readonly upgradeUrl?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function buildBody(inputs: ActionInputs): Record<string, unknown> {
  return {
    url: inputs.url,
    ...(inputs.siteType ? { siteType: inputs.siteType } : {}),
    ...(inputs.scope ? { scope: inputs.scope } : {}),
    minScore: inputs.minScore,
    minGrade: inputs.minGrade,
    ...(Object.keys(inputs.headers).length > 0 ? { headers: inputs.headers } : {}),
    resolveLinks: inputs.resolveLinks,
    agentFetch: inputs.agentFetch,
    reportStyle: inputs.reportStyle,
    timeoutMs: inputs.timeoutMs,
  };
}

function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers.get("retry-after"));
  if (!Number.isFinite(seconds) || seconds < 0 || response.headers.get("retry-after") === null) {
    return DEFAULT_RETRY_AFTER_MS;
  }
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

async function toApiError(response: Response): Promise<ApiError> {
  let code = "unknown_error";
  let message = `The scan service returned HTTP ${response.status}.`;
  let upgradeUrl: string | undefined;
  try {
    const parsed = (await response.json()) as {
      error?: { code?: unknown; message?: unknown; upgradeUrl?: unknown };
    };
    if (typeof parsed.error?.code === "string") code = parsed.error.code;
    if (typeof parsed.error?.message === "string") message = parsed.error.message;
    if (typeof parsed.error?.upgradeUrl === "string") upgradeUrl = parsed.error.upgradeUrl;
  } catch {
    // Keep the generic message when the body is not the documented error shape.
  }
  return new ApiError(message, response.status, code, upgradeUrl);
}

function isScanResponse(value: unknown): value is ScanResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const md = v.markdown as Record<string, unknown> | undefined;
  return (
    typeof v.score === "number" &&
    typeof v.grade === "string" &&
    typeof v.passed === "boolean" &&
    typeof md?.summary === "string" &&
    typeof md?.prComment === "string"
  );
}

/**
 * Sends the scan request. Retries once on 429 (after Retry-After, up to 60 s),
 * on 502/503 and on network errors or timeouts. Other statuses fail at once.
 */
export async function requestScan(
  inputs: ActionInputs,
  deps: ApiDeps = {},
): Promise<ScanResponse> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const endpoint = `${inputs.serverUrl}/api/v1/scans`;
  const body = JSON.stringify(buildBody(inputs));

  let lastError: ApiError | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let waitMs = 0;
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${inputs.apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": USER_AGENT,
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (response.status === 200) {
        let parsed: unknown;
        try {
          parsed = await response.json();
        } catch {
          throw new ApiError("The scan service returned an unreadable response.", 200, "bad_response");
        }
        if (!isScanResponse(parsed)) {
          throw new ApiError("The scan service returned an unexpected response.", 200, "bad_response");
        }
        return parsed;
      }

      lastError = await toApiError(response);
      if (response.status === 429) waitMs = retryAfterMs(response);
      else if (response.status === 502 || response.status === 503) waitMs = RETRY_BACKOFF_MS;
      else throw lastError;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // Network error or timeout: never include the cause, it may echo request details.
      lastError = new ApiError(
        "Could not reach the scan service (network error or timeout).",
        null,
        "network_error",
      );
      waitMs = RETRY_BACKOFF_MS;
    }

    if (attempt === 0) await sleep(waitMs);
  }
  throw lastError ?? new ApiError("The scan failed.", null, "network_error");
}

/** Turns an API error into the actionable message shown in the job log. */
export function describeApiError(error: ApiError, serverUrl: string): string {
  switch (error.code) {
    case "unauthorized":
      return `LLM Ready API key invalid, expired or revoked. Create one at ${serverUrl}/account/api-keys and store it as a secret.`;
    case "domain_limit_reached":
      return `${error.message} Upgrade here: ${error.upgradeUrl ?? `${serverUrl}/account`}`;
    case "invalid_request":
    case "target_not_allowed":
      return `The scan request was rejected: ${error.message}`;
    case "rate_limited":
      return `Rate limited by the scan service even after one retry. Try again later. ${error.message}`;
    case "target_unreachable":
      return `The scan service could not reach the target URL: ${error.message}`;
    case "service_unavailable":
      return `The scan service is temporarily unavailable. ${error.message}`;
    case "internal_error":
      return `The scan service hit an internal error. ${error.message}`;
    case "network_error":
      return error.message;
    default:
      return `Scan failed (${error.status ?? "no status"}): ${error.message}`;
  }
}
