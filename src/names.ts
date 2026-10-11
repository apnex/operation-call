/**
 * Names and identities (zorg's target, EM1 and EM11).
 *
 * An operation and the name a host serves under match EM1's pattern. An invocation identity is the
 * caller's wall-clock time in milliseconds when the invocation was made, in 13 digits, a hyphen and 16
 * random lowercase hexadecimal digits; an attempt identity is the invocation identity, a dot and 8 random
 * lowercase hexadecimal digits, new for every attempt, and is AGP's correlation label for the request
 * and for every message answering it.
 */

/** EM1's name pattern, for operations and the names hosts serve under. */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** EM11's invocation identity. */
export const INVOCATION_PATTERN = /^[0-9]{13}-[0-9a-f]{16}$/;

/** EM11's attempt identity. */
export const ATTEMPT_PATTERN = /^[0-9]{13}-[0-9a-f]{16}\.[0-9a-f]{8}$/;

/** The caller's reply endpoint (EM11). */
export const REPLY_ENDPOINT = "operation-call/replies";

/** The operation every host answers with its description (EM10). */
export const DESCRIBE_OPERATION = "describe";

/** True when a value is a name as EM1 allows. */
export function isName(value: unknown): value is string {
	return typeof value === "string" && NAME_PATTERN.test(value);
}

/** True when a value is an invocation identity as EM11 writes it. */
export function isInvocationId(value: unknown): value is string {
	return typeof value === "string" && INVOCATION_PATTERN.test(value);
}

/** True when a value is an attempt identity as EM11 writes it. */
export function isAttemptId(value: unknown): value is string {
	return typeof value === "string" && ATTEMPT_PATTERN.test(value);
}

/** The invocation identity an attempt identity holds. */
export function invocationOfAttempt(attempt: string): string {
	return attempt.slice(0, attempt.indexOf("."));
}

/** Where an invocation identity's time and randomness come from (the caller's ports). */
export interface IdentitySource {
	/** The caller's wall-clock time, in milliseconds since 1970. */
	wallTimeMs(): number;
	/** A string of `digits` random lowercase hexadecimal digits. */
	randomHex(digits: number): string;
}

/** Checks what an identity source gave: `digits` lowercase hexadecimal digits. */
function hexFrom(source: IdentitySource, digits: number): string {
	const hex = source.randomHex(digits);
	if (typeof hex !== "string" || !new RegExp(`^[0-9a-f]{${digits}}$`).test(hex)) {
		throw new TypeError(`the identity source gave ${JSON.stringify(hex)}, not ${digits} lowercase hexadecimal digits`);
	}
	return hex;
}

/** A new invocation identity. */
export function makeInvocationId(source: IdentitySource): string {
	const ms = source.wallTimeMs();
	if (typeof ms !== "number" || !Number.isFinite(ms)) throw new TypeError("the identity source gave a wall-clock time that is not a finite number");
	const whole = Math.floor(ms);
	if (whole < 0 || whole > 9999999999999) throw new RangeError("the identity source gave a wall-clock time that is not 13 digits of milliseconds");
	return `${String(whole).padStart(13, "0")}-${hexFrom(source, 16)}`;
}

/** A new attempt identity for an invocation. */
export function makeAttemptId(source: IdentitySource, invocation: string): string {
	return `${invocation}.${hexFrom(source, 8)}`;
}
