import { logError, ProviderError } from "@ccflare/core";
import { Logger } from "@ccflare/logger";
import type { Account, RequestMeta } from "@ccflare/types";
import { forwardToClient } from "../response-handler";
import { ERROR_MESSAGES, type ResolvedProxyContext } from "./proxy-types";
import { makeProxyRequest } from "./request-handler";
import {
	handleProxyError,
	isRetryableUpstreamError,
	processProxyResponse,
} from "./response-processor";
import { getValidAccessToken } from "./token-manager";

const log = new Logger("ProxyOperations");

/**
 * Computes the backoff delay for the next retry attempt.
 * Attempt 0 is the first retry (i.e. invoked after the initial request),
 * so the delay grows as `delayMs * backoff^attempt`.
 */
function computeBackoffDelay(
	attempt: number,
	delayMs: number,
	backoff: number,
): number {
	return delayMs * backoff ** attempt;
}

function sleep(ms: number): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Handles proxy request without authentication
 * @param req - The incoming request
 * @param url - The parsed URL
 * @param requestMeta - Request metadata
 * @param requestBodyBuffer - Buffered request body
 * @param createBodyStream - Function to create body stream
 * @param ctx - The proxy context
 * @returns Promise resolving to the response
 * @throws {ProviderError} If the unauthenticated request fails
 */
export async function proxyUnauthenticated(
	req: Request,
	url: URL,
	requestMeta: RequestMeta,
	requestBodyBuffer: ArrayBuffer | null,
	createBodyStream: () => ReadableStream<Uint8Array> | undefined,
	ctx: ResolvedProxyContext,
): Promise<Response> {
	log.warn(ERROR_MESSAGES.NO_ACCOUNTS);

	const targetUrl = ctx.provider.buildUrl(ctx.upstreamPath, url.search);
	const headers = ctx.provider.prepareHeaders(req.headers, null);

	try {
		const upstreamRequestStartedAt = Date.now();
		const response = await makeProxyRequest(
			targetUrl,
			req.method,
			headers,
			createBodyStream,
			!!req.body,
		);
		const responseHeadersReceivedAt = Date.now();

		return forwardToClient(
			{
				requestId: requestMeta.id,
				method: requestMeta.method,
				path: url.pathname,
				account: null,
				requestHeaders: req.headers,
				requestBody: requestBodyBuffer,
				response,
				timestamp: requestMeta.timestamp,
				upstreamRequestStartedAt,
				responseHeadersReceivedAt,
				retryAttempt: 0,
				failoverAttempts: 0,
			},
			ctx,
		);
	} catch (error) {
		logError(error, log);
		throw new ProviderError(
			ERROR_MESSAGES.UNAUTHENTICATED_FAILED,
			ctx.providerName,
			502,
			{
				originalError: error instanceof Error ? error.message : String(error),
			},
		);
	}
}

/**
 * Attempts to proxy a request with a specific account
 * @param req - The incoming request
 * @param url - The parsed URL
 * @param account - The account to use
 * @param requestMeta - Request metadata
 * @param requestBodyBuffer - Buffered request body
 * @param createBodyStream - Function to create body stream
 * @param failoverAttempts - Number of failover attempts
 * @param ctx - The proxy context
 * @returns Promise resolving to response or null if failed
 */
export async function proxyWithAccount(
	req: Request,
	url: URL,
	account: Account,
	requestMeta: RequestMeta,
	requestBodyBuffer: ArrayBuffer | null,
	createBodyStream: () => ReadableStream<Uint8Array> | undefined,
	failoverAttempts: number,
	ctx: ResolvedProxyContext,
): Promise<Response | null> {
	try {
		log.info(`Attempting request with account: ${account.name}`);

		// Get valid access token
		const accessToken = await getValidAccessToken(account, ctx);

		// Prepare request
		const requestAccount =
			accessToken === account.access_token
				? account
				: { ...account, access_token: accessToken };
		const headers = ctx.provider.prepareHeaders(req.headers, requestAccount);
		const targetUrl = ctx.provider.buildUrl(
			ctx.upstreamPath,
			url.search,
			account,
		);

		// Retry transient 5xx responses against the SAME account when the
		// upstream explicitly opts in via `x-should-retry: true` (e.g. Anthropic
		// 529 "Overloaded"). `retry.attempts` counts how many *retries* follow
		// the initial request, so the upstream is called at most `attempts + 1`
		// times before we fall through to the next account.
		const { attempts, delayMs, backoff } = ctx.runtime.retry;
		let response: Response | null = null;
		let upstreamRequestStartedAt = Date.now();
		let responseHeadersReceivedAt = upstreamRequestStartedAt;
		// Counts retries that actually happened against THIS account. Stays 0
		// when the very first response is acceptable. Reaches `attempts` when
		// the budget is exhausted. Persisted to the `requests.retry_attempt`
		// column so operators can run
		// `SELECT COUNT(*) FROM requests WHERE retry_attempt > 0` to confirm
		// the same-account retry path is rescuing 5xx + `x-should-retry`
		// upstream responses.
		let retryAttempt = 0;

		for (let attempt = 0; attempt <= attempts; attempt++) {
			upstreamRequestStartedAt = Date.now();
			response = await makeProxyRequest(
				targetUrl,
				req.method,
				headers,
				createBodyStream,
				!!req.body,
			);
			responseHeadersReceivedAt = Date.now();

			if (!isRetryableUpstreamError(response)) {
				break;
			}

			if (attempt < attempts) {
				const nextAttempt = attempt + 1;
				const waitMs = computeBackoffDelay(attempt, delayMs, backoff);
				log.warn(
					`Retry attempt ${nextAttempt}/${attempts} for account ${account.name} after upstream ${response.status} (x-should-retry); waiting ${waitMs}ms`,
				);
				retryAttempt = nextAttempt;
				await sleep(waitMs);
			} else {
				log.warn(
					`Exhausted ${attempts} retries for account ${account.name} after upstream ${response.status} (x-should-retry); failing over`,
				);
			}
		}

		// `attempts >= 0` plus the `break`/exhaustion paths above guarantee
		// `response` is non-null here, but narrow it for the type checker.
		if (!response) {
			return null;
		}

		// If the upstream is still asking us to retry after exhausting our
		// budget, signal failover so the outer loop picks the next account.
		if (isRetryableUpstreamError(response)) {
			return null;
		}

		// Process response and check for rate limit
		const isRateLimited = processProxyResponse(response, account, ctx);
		if (isRateLimited) {
			return null; // Signal to try next account
		}

		// Forward response to client
		return forwardToClient(
			{
				requestId: requestMeta.id,
				method: requestMeta.method,
				path: url.pathname,
				account,
				requestHeaders: req.headers,
				requestBody: requestBodyBuffer,
				response,
				timestamp: requestMeta.timestamp,
				upstreamRequestStartedAt,
				responseHeadersReceivedAt,
				retryAttempt,
				failoverAttempts,
			},
			ctx,
		);
	} catch (err) {
		handleProxyError(err, account, log);
		return null;
	}
}
