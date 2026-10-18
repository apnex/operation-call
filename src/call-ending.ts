/**
 * Reading a candidate ending (zorg's target, EM12; zorg's D54 and D55): `readCallEnding` reads a value as plain
 * data through shape-check's `readPlainJson`, running none of its code, and accepts it only when it holds
 * exactly the fields of one of the four kinds of `CallEnding` - every ending an implementation of the caller
 * interface honestly gives: the call layer's own, those a caller across a hop decides itself, and the whole
 * find's `bound-passed` ending with `attempt` null. No single message's size or depth limit applies.
 */
import { readPlainJson } from "@apnex/shape-check";
import type { CallEnding } from "./call-types.js";
import { ATTEMPT_PATTERN, INVOCATION_PATTERN, NAME_PATTERN } from "./names.js";
import { readRefusalRecord } from "./refusal.js";

const REFUSED: { readonly ok: false } = Object.freeze({ ok: false });

const ADDRESS = ["ending", "invocation", "attempt", "operation"];

/** The reasons an unknown ending may give, through any caller (EM12; operation-proxy's PX6). */
const UNKNOWN_REASONS = new Set(["bound-passed", "operation-failed", "answer-not-sendable", "part-missing", "proxy-lost", "hop-stalled"]);

/** The reasons of an unknown ending that names no attempt: a hop's, and the whole find's passed bound. */
const UNATTEMPTED_REASONS = new Set(["proxy-lost", "hop-stalled", "bound-passed"]);

/** True for a JSON object, false for null, arrays and scalars. */
function isObject(value: unknown): value is { readonly [name: string]: unknown } {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** True for a string holding at least one character. */
function isFilled(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/** True when an object holds exactly the named keys. */
function holdsExactly(value: { readonly [name: string]: unknown }, names: readonly string[]): boolean {
	const own = Object.keys(value);
	return own.length === names.length && names.every((n) => Object.hasOwn(value, n));
}

/** True when the ending's fields, all of them already plain JSON, are those of one kind of `CallEnding`. */
function isEnding(value: { readonly [name: string]: unknown }): boolean {
	const { invocation, attempt, operation } = value;
	if (typeof invocation !== "string" || !INVOCATION_PATTERN.test(invocation)) return false;
	if (typeof operation !== "string" || !NAME_PATTERN.test(operation)) return false;
	const attempted = typeof attempt === "string";
	if (attempted ? !(ATTEMPT_PATTERN.test(attempt) && attempt.startsWith(`${invocation}.`)) : attempt !== null) return false;
	switch (value.ending) {
		case "answered":
			return attempted && holdsExactly(value, [...ADDRESS, "answer"]);
		case "refused":
			return attempted && holdsExactly(value, [...ADDRESS, "refusal"]) && readRefusalRecord(value.refusal).ok;
		case "not-delivered":
			if (!holdsExactly(value, [...ADDRESS, "agpCode", "proxyCode", "earlierAttemptsUncertain"])) return false;
			if (typeof value.earlierAttemptsUncertain !== "boolean") return false;
			// The call layer's names its attempt and AGP's code; a hop's names neither, and its own code.
			return attempted
				? isFilled(value.agpCode) && value.proxyCode === null
				: value.agpCode === null && isFilled(value.proxyCode);
		case "unknown":
			if (!holdsExactly(value, [...ADDRESS, "reason", "agpCode", "deliveryReport"])) return false;
			if (!attempted) return UNATTEMPTED_REASONS.has(value.reason as string) && value.agpCode === null && value.deliveryReport === null;
			return UNKNOWN_REASONS.has(value.reason as string)
				&& (value.agpCode === null || isFilled(value.agpCode))
				&& (value.deliveryReport === null || value.deliveryReport === "delivered" || value.deliveryReport === "unknown");
		default:
			return false;
	}
}

/**
 * Reads a candidate ending as plain data (zorg's D54, D55) and checks it holds exactly the fields of one kind of
 * `CallEnding` - direct, hop or the whole find's, `attempt` null on its `bound-passed` ending included - giving
 * the ending deeply frozen, or `{ok: false}`.
 */
export function readCallEnding(value: unknown): { readonly ok: true; readonly ending: CallEnding } | { readonly ok: false } {
	const reading = readPlainJson(value);
	if (!reading.ok || !isObject(reading.value) || !isEnding(reading.value)) return REFUSED;
	return Object.freeze({ ok: true, ending: reading.value as unknown as CallEnding });
}
