/**
 * The refusal record (zorg's target, EM9; zorg's D21) and operation-call's own refusals.
 *
 * Every application refusal is a record with exactly `part`, `code`, `what`, `why`, `fix` and `details`,
 * and, on a refusal for a misfit only, `misfits`, shape-check's records unchanged. A part that carries
 * another's refusal passes it on unchanged. operation-call's own codes are `input-misfit`,
 * `malformed-request` and `not-sendable`, none naming any detail. A failure of AGP's is never a refusal.
 */
import { readPlainJson, type ShapeMisfit } from "@apnex/shape-check";
import { isJson, isJsonObject, type JsonValue } from "./json-value.js";

/** A refusal record (EM9). */
export interface RefusalRecord {
	readonly part: string;
	readonly code: string;
	readonly what: string;
	readonly why: string;
	readonly fix: string;
	readonly details: { readonly [name: string]: JsonValue };
	readonly misfits?: readonly ShapeMisfit[];
}

/** operation-call's own refusal codes (EM9). */
export type CallRefusalCode = "input-misfit" | "malformed-request" | "not-sendable";

const MISFIT_FIELDS = ["expected", "fit", "keyword", "pointer"];
const REFUSAL_FIELDS = ["code", "details", "fix", "part", "what", "why"];

/** True when a value is a misfit record of shape-check's SD4: exactly pointer, keyword, expected and fit. */
function isMisfit(value: unknown): boolean {
	if (!isJsonObject(value)) return false;
	const names = Object.keys(value).sort();
	return names.length === 4 && names.every((n, i) => n === MISFIT_FIELDS[i])
		&& typeof value.pointer === "string" && typeof value.keyword === "string" && typeof value.fit === "string";
}

/** True when a value has exactly EM9's form: the six fields, `misfits` only beside them, each of its type. */
export function isRefusalRecord(value: unknown): value is RefusalRecord {
	if (!isJsonObject(value) || !isJson(value)) return false;
	const names = Object.keys(value).filter((n) => n !== "misfits").sort();
	if (names.length !== REFUSAL_FIELDS.length || !names.every((n, i) => n === REFUSAL_FIELDS[i])) return false;
	if (!["part", "code", "what", "why", "fix"].every((n) => typeof value[n] === "string")) return false;
	if (!isJsonObject(value.details)) return false;
	if (Object.hasOwn(value, "misfits")) {
		const misfits = value.misfits;
		if (!Array.isArray(misfits) || !misfits.every(isMisfit)) return false;
	}
	return true;
}

const NAMED_FIELDS = ["part", "code", "what", "why", "fix"];

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

/** True when a plain JSON value is a misfit record of shape-check's SD4, its keyword named. */
function isPlainMisfit(value: unknown): boolean {
	return isObject(value) && holdsExactly(value, MISFIT_FIELDS)
		&& typeof value.pointer === "string" && isFilled(value.keyword) && typeof value.fit === "string";
}

/**
 * Reads a candidate refusal as plain data (zorg's D54, D55) through shape-check's `readPlainJson`, running none
 * of its code, and checks EM9's exact form: `part`, `code`, `what`, `why` and `fix` non-empty strings, `details`
 * an object, and, only beside them, `misfits`, a non-empty list of SD4's misfit records. Gives the refusal
 * deeply frozen, or `{ok: false}`.
 */
export function readRefusalRecord(value: unknown): { readonly ok: true; readonly refusal: RefusalRecord } | { readonly ok: false } {
	const reading = readPlainJson(value);
	if (!reading.ok) return Object.freeze({ ok: false });
	const refusal = reading.value;
	if (!isObject(refusal)) return Object.freeze({ ok: false });
	const fields = Object.hasOwn(refusal, "misfits") ? [...REFUSAL_FIELDS, "misfits"] : REFUSAL_FIELDS;
	if (!holdsExactly(refusal, fields) || !NAMED_FIELDS.every((n) => isFilled(refusal[n])) || !isObject(refusal.details)) return Object.freeze({ ok: false });
	if (Object.hasOwn(refusal, "misfits")) {
		const misfits = refusal.misfits;
		if (!Array.isArray(misfits) || misfits.length === 0 || !misfits.every(isPlainMisfit)) return Object.freeze({ ok: false });
	}
	return Object.freeze({ ok: true, refusal: refusal as unknown as RefusalRecord });
}

/** A misfit refusal: the input does not fit the operation's declared shape (EM9). */
export function inputMisfit(operation: string, misfits: readonly ShapeMisfit[]): RefusalRecord {
	return Object.freeze({
		part: "operation-call",
		code: "input-misfit",
		what: `The input does not fit the declared input shape of operation ${operation}.`,
		why: "An operation runs only on input that fits the shape it declared.",
		fix: "Change the input as each misfit record says, then call again; the host's description gives the shape.",
		details: Object.freeze({}),
		misfits,
	});
}

/** A request that breaks EM11's request form, or names an operation other than its endpoint's (EM9). */
export function malformedRequest(): RefusalRecord {
	return Object.freeze({
		part: "operation-call",
		code: "malformed-request",
		what: "The request breaks operation-call's request form, or names an operation other than the one its endpoint serves.",
		why: "A host runs an operation only for a request in operation-call's form, sent to that operation's own endpoint.",
		fix: "Send the request through an operation-call caller, which writes the form EM11 states.",
		details: Object.freeze({}),
	});
}

/** A request that could not cross AGP whole, refused on the caller's side before sending (EM9, EM11). */
export function notSendable(): RefusalRecord {
	return Object.freeze({
		part: "operation-call",
		code: "not-sendable",
		what: "The request would nest more than 30 levels, hold an integer more than 9007199254740991 from zero, or exceed 16777216 bytes as JSON.",
		why: "AGP carries no such message to any peer, so the request was not sent.",
		fix: "Make the input shallower, keep every integer within 9007199254740991 of zero, or send less, then call again.",
		details: Object.freeze({}),
	});
}
