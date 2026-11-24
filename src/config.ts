/** Base URL of the scan service. TODO(owner): set production URL */
export const DEFAULT_SERVER_URL = "https://TODO-set-production-url.example";

/** Marker that identifies the sticky pull request comment. */
export const MARKER = "llm-seo-toolbox-audit-report";

/** Overall deadline for one scan request; the audit runs inside the request. */
export const REQUEST_TIMEOUT_MS = 120_000;
/** Longest Retry-After the action will wait for. */
export const MAX_RETRY_AFTER_MS = 60_000;
/** Backoff before retrying a 502/503 or a network error. */
export const RETRY_BACKOFF_MS = 3_000;
/** Wait when a 429 carries no usable Retry-After header. */
export const DEFAULT_RETRY_AFTER_MS = 5_000;

export const USER_AGENT = "llm-ready-action/1";
