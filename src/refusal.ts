/**
 * The refusal record (zorg's target, EM9; zorg's D21) and operation-call's own refusals.
 *
 * Every application refusal is a record with exactly `part`, `code`, `what`, `why`, `fix` and `details`,
 * and, on a refusal for a misfit only, `misfits`, shape-check's records unchanged. A part that carries
 * another's refusal passes it on unchanged. operation-call's own codes are `input-misfit`,
 * `malformed-request` and `not-sendable`, none naming any detail. A failure of AGP's is never a refusal.
 */
import type { ShapeMisfit } from "@apnex/shape-check";
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
