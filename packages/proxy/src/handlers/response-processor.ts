import { logError, RateLimitError } from "@ccflare/core";
import { Logger } from "@ccflare/logger";
import type { RateLimitInfo } from "@ccflare/providers";
import type { Account } from "@ccflare/types";
import type { ResolvedProxyContext } from "./proxy-types";

const log = new Logger("ResponseProcessor");

/**
 * Determines whether an upstream response is a transient server-side error
 * that the provider has explicitly marked as retryable via the
 * `x-should-retry: true` header.
 *
 * Anthropic uses this for HTTP 529 ("Overloaded") and other transient 5xx
 * conditions. Rate-limit responses (HTTP 429) follow the dedicated
 * rate-limit handling path and are intentionally excluded here.
 *
 * @param response - The upstream response to inspect
 * @returns true if the same account should be retried, false otherwise
 */
export function isRetryableUpstreamError(response: Response): boolean {
	if (response.status < 500) {
		return false;
	}
	return response.headers.get("x-should-retry") === "true";
}

/**
 * Handles rate limit response for an account
 * @param account - The rate-limited account
 * @param rateLimitInfo - Parsed rate limit information
 * @param ctx - The proxy context
 */
export function handleRateLimitResponse(
	account: Account,
	rateLimitInfo: RateLimitInfo,
	ctx: ResolvedProxyContext,
): void {
	if (!rateLimitInfo.resetTime) return;

	log.warn(
		`Account ${account.name} rate-limited until ${new Date(
			rateLimitInfo.resetTime,
		).toISOString()}`,
	);

	const resetTime = rateLimitInfo.resetTime;
	ctx.asyncWriter.enqueue(() =>
		ctx.dbOps.markAccountRateLimited(account.id, resetTime),
	);

	const rateLimitError = new RateLimitError(
		account.id,
		rateLimitInfo.resetTime,
		rateLimitInfo.remaining,
	);
	logError(rateLimitError, log);
}

/**
 * Updates account rate-limit metadata in the background.
 * Usage counters are owned by the worker after it processes the full response.
 * Accepts pre-parsed rate limit info to avoid re-parsing headers.
 */
export function updateAccountMetadata(
	account: Account,
	rateLimitInfo: RateLimitInfo,
	ctx: ResolvedProxyContext,
): void {
	// Only update rate limit metadata when we have actual rate limit headers
	if (rateLimitInfo.statusHeader) {
		const status = rateLimitInfo.statusHeader;
		ctx.asyncWriter.enqueue(() =>
			ctx.dbOps.updateAccountRateLimitMeta(
				account.id,
				status,
				rateLimitInfo.resetTime ?? null,
				rateLimitInfo.remaining,
			),
		);
	}
}

/**
 * Processes a successful proxy response
 * @param response - The provider response
 * @param account - The account used
 * @param ctx - The proxy context
 * @returns Whether the response is rate-limited
 */
export function processProxyResponse(
	response: Response,
	account: Account,
	ctx: ResolvedProxyContext,
): boolean {
	const isStream = ctx.provider.isStreamingResponse?.(response) ?? false;
	// Parse rate-limit headers once and pass the result through
	const rateLimitInfo = ctx.provider.parseRateLimit(response);

	// Handle rate limit
	if (!isStream && rateLimitInfo.isRateLimited) {
		handleRateLimitResponse(account, rateLimitInfo, ctx);
		updateAccountMetadata(account, rateLimitInfo, ctx);
		return true; // Signal rate limit
	}

	// Update account metadata in background
	updateAccountMetadata(account, rateLimitInfo, ctx);
	return false;
}

/**
 * Handles errors that occur during proxy operations
 * @param error - The error that occurred
 * @param account - The account that failed (optional)
 * @param logger - Logger instance
 */
export function handleProxyError(
	error: unknown,
	account: Account | null,
	logger: Logger,
): void {
	logError(error, logger);
	if (account) {
		logger.error(`Failed to proxy request with account ${account.name}`);
	} else {
		logger.error("Failed to proxy request");
	}
}
