import { readFileSync } from "node:fs";

export interface PullRequestContext {
  apiUrl: string;
  owner: string;
  repo: string;
  number: number;
  token: string;
  /** True when the pull request head lives in a different repository. */
  fromFork: boolean;
}

interface GitHubComment {
  id: number;
  body?: string;
  html_url?: string;
}

type Env = Record<string, string | undefined>;
type ReadFile = (path: string) => string;

const defaultRead: ReadFile = (path) => readFileSync(path, "utf8");

function readEvent(env: Env, readFile: ReadFile): Record<string, unknown> | null {
  if (!env.GITHUB_EVENT_PATH) return null;
  try {
    return JSON.parse(readFile(env.GITHUB_EVENT_PATH)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** True for a `pull_request*` event whose head repository is a fork. */
export function isForkPullRequest(env: Env = process.env, readFile: ReadFile = defaultRead): boolean {
  if (!env.GITHUB_EVENT_NAME?.startsWith("pull_request")) return false;
  const event = readEvent(env, readFile);
  const pr = event?.pull_request as
    | { head?: { repo?: { fork?: boolean; full_name?: string } | null } }
    | undefined;
  const headRepo = pr?.head?.repo;
  if (!headRepo) return false;
  if (headRepo.fork === true) return true;
  return Boolean(
    headRepo.full_name && env.GITHUB_REPOSITORY && headRepo.full_name !== env.GITHUB_REPOSITORY,
  );
}

/**
 * Reads the pull request number from the workflow event. Returns null for push
 * events and for contexts without a token, so callers can skip commenting.
 */
export function pullRequestContext(
  token: string | null,
  env: Env = process.env,
  readFile: ReadFile = defaultRead,
): PullRequestContext | null {
  const [owner, repo] = (env.GITHUB_REPOSITORY ?? "").split("/");
  if (!owner || !repo || !token) return null;

  const event = readEvent(env, readFile);
  const number = Number((event?.pull_request as { number?: unknown } | undefined)?.number);
  if (!Number.isInteger(number) || number <= 0) return null;

  return {
    apiUrl: (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, ""),
    owner,
    repo,
    number,
    token,
    fromFork: isForkPullRequest(env, readFile),
  };
}

function headers(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": "llm-ready-action",
    "x-github-api-version": "2022-11-28",
  };
}

async function apiError(response: Response): Promise<Error> {
  let detail = "";
  try {
    detail = (await response.text()).slice(0, 500);
  } catch {
    // The status is enough when the body cannot be read.
  }
  return new Error(`GitHub API ${response.status}${detail ? `: ${detail}` : ""}`);
}

/**
 * Creates or updates the single audit comment marked by `marker`. This keeps
 * pull requests from accumulating one comment per push.
 */
export async function upsertPullRequestComment(
  context: PullRequestContext,
  marker: string,
  body: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ action: "created" | "updated"; url?: string }> {
  const commentsUrl = `${context.apiUrl}/repos/${context.owner}/${context.repo}/issues/${context.number}/comments`;
  let existing: GitHubComment | undefined;

  for (let page = 1; page <= 5 && !existing; page += 1) {
    const response = await fetchImpl(`${commentsUrl}?per_page=100&page=${page}`, {
      headers: headers(context.token),
    });
    if (!response.ok) throw await apiError(response);

    const comments = (await response.json()) as GitHubComment[];
    if (!Array.isArray(comments) || comments.length === 0) break;
    existing = comments.find((comment) => comment.body?.includes(marker));
    if (comments.length < 100) break;
  }

  if (existing) {
    const response = await fetchImpl(
      `${context.apiUrl}/repos/${context.owner}/${context.repo}/issues/comments/${existing.id}`,
      { method: "PATCH", headers: headers(context.token), body: JSON.stringify({ body }) },
    );
    if (!response.ok) throw await apiError(response);
    const updated = (await response.json()) as GitHubComment;
    return { action: "updated", url: updated.html_url };
  }

  const response = await fetchImpl(commentsUrl, {
    method: "POST",
    headers: headers(context.token),
    body: JSON.stringify({ body }),
  });
  if (!response.ok) throw await apiError(response);
  const created = (await response.json()) as GitHubComment;
  return { action: "created", url: created.html_url };
}
