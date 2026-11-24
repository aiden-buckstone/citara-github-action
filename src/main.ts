import * as core from "@actions/core";

import { ApiError, describeApiError, requestScan, type ApiDeps, type ScanResponse } from "./api";
import { isForkPullRequest, pullRequestContext, upsertPullRequestComment } from "./comment";
import { MARKER } from "./config";
import { ActionInputError, readInputs, type InputGetter } from "./inputs";

export interface RunDeps extends ApiDeps {
  getInput?: InputGetter;
  env?: Record<string, string | undefined>;
}

/** The comment must carry the marker so the next run updates it in place. */
export function withMarker(body: string): string {
  return body.includes(MARKER) ? body : `<!-- ${MARKER} -->\n\n${body}`;
}

/** Drops the leading HTML marker comment, which has no place in a job summary. */
function summaryMarkdown(markdown: string): string {
  return markdown.replace(/^\s*<!--[^>]*-->\s*/, "").trimEnd();
}

async function commentOnPullRequest(
  body: string,
  token: string | null,
  deps: RunDeps,
): Promise<void> {
  const env = deps.env ?? process.env;
  const context = pullRequestContext(token, env);
  if (!context) {
    core.info("No pull request context or token available; skipping the PR comment.");
    return;
  }
  try {
    const result = await upsertPullRequestComment(
      context,
      MARKER,
      withMarker(body),
      deps.fetchImpl,
    );
    core.info(`PR comment ${result.action}${result.url ? `: ${result.url}` : ""}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.warning(`Could not write the pull request comment: ${message}`);
  }
}

function failOrWarn(failOnError: boolean, message: string): void {
  if (failOnError) {
    core.setOutput("passed", "false");
    core.setFailed(message);
  } else {
    core.warning(message);
  }
}

function gateMessage(result: ScanResponse): string {
  const gate = result.thresholds;
  const misses: string[] = [];
  if (gate && !gate.scorePassed) misses.push(`score ${result.score} < ${gate.minScore}`);
  if (gate && !gate.gradePassed) misses.push(`grade ${result.grade} < ${gate.minGrade}`);
  return `LLM Ready gate failed: ${misses.join(", ") || `score ${result.score}, grade ${result.grade}, threshold missed`}`;
}

export async function run(deps: RunDeps = {}): Promise<void> {
  const get: InputGetter = deps.getInput ?? ((name) => core.getInput(name));
  const env = deps.env ?? process.env;

  // Mask the key before anything else can log it.
  const apiKey = get("api-key").trim();
  if (apiKey) core.setSecret(apiKey);

  let failOnError = true;
  try {
    if (!apiKey) {
      if (isForkPullRequest(env)) {
        core.warning(
          "No LLM Ready API key is available. Secrets are not shared with pull requests from forks, so the audit was skipped.",
        );
        return;
      }
      throw new ActionInputError(
        "The api-key input is empty. Store your key as a secret (for example LLMSEO_API_KEY) and pass it with api-key: ${{ secrets.LLMSEO_API_KEY }}.",
      );
    }

    const inputs = readInputs(get);
    failOnError = inputs.failOnError;

    core.info(`Auditing ${inputs.url} via ${inputs.serverUrl}`);

    let result: ScanResponse;
    try {
      result = await requestScan(inputs, deps);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      failOrWarn(failOnError, describeApiError(error, inputs.serverUrl));
      return;
    }

    core.info(`Score: ${result.score}/100, grade ${result.grade}`);
    if (result.reportUrl) core.info(`Report: ${result.reportUrl}`);

    core.summary.addRaw(`${summaryMarkdown(result.markdown.summary)}\n`, true);
    try {
      await core.summary.write();
    } catch (error) {
      core.warning(`Could not write the job summary: ${error instanceof Error ? error.message : error}`);
    }

    core.setOutput("score", String(result.score));
    core.setOutput("grade", result.grade);
    core.setOutput("passed", String(result.passed));
    core.setOutput("report-url", result.reportUrl ?? "");
    core.setOutput("scan-id", result.scanId ?? "");
    core.setOutput("report-json", JSON.stringify(result.report));

    if (inputs.commentOnPr) {
      await commentOnPullRequest(result.markdown.prComment, inputs.githubToken, deps);
    }

    if (!result.passed) {
      core.setFailed(gateMessage(result));
      return;
    }
    core.info("LLM Ready gate passed.");
  } catch (error) {
    if (error instanceof ActionInputError) {
      core.setOutput("passed", "false");
      core.setFailed(error.message);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    failOrWarn(failOnError, `LLM Ready action failed: ${message}`);
  }
}
