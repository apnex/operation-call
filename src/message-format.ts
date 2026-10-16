/**
 * operation-call's message format (zorg's target, EM11; zorg's D8, D9), exported as
 * `@apnex/operation-call/message-format` so another implementation of the caller's side - operation-proxy's
 * client half (its PX5) - applies the same checks and writes the same messages.
 *
 * Every message is a JSON object holding `operationCall`, which is 1, `type`, and exactly the fields its
 * type names: a `request`; an `end`, answered, refused or failed; or a `part`, which the format admits
 * though no operation of the first version sends one (D9). Every message must cross AGP whole: counting
 * the message itself as the first level it nests at most 30 levels, and every integer in it lies within
 * 9007199254740991 of zero; a request message is also at most 16777216 bytes as JSON in UTF-8.
 */
import { firstUnsafeInteger, nestingDepth, readPlainJson, toCanonicalJson, utf8ByteLength, type JsonObject, type JsonValue } from "@apnex/shape-check";
import { invocationOfAttempt, isAttemptId, isInvocationId, isName } from "./names.js";
import { isRefusalRecord, type RefusalRecord } from "./refusal.js";

export { ATTEMPT_PATTERN, INVOCATION_PATTERN, isAttemptId, isInvocationId, NAME_PATTERN, REPLY_ENDPOINT } from "./names.js";

/** The limits a message must keep to cross AGP whole (EM11). */
export const MESSAGE_LIMITS = Object.freeze({
	/** Levels of nesting, the message itself the first; AGP adds two, reaching its 32. */
	depth: 30,
	/** The largest receive limit AGP allows any peer (AGP's maxReceiveBytes); no request message may exceed it. */
	requestBytes: 16777216,
	/** The largest distance from zero of an integer in any message. */
	safeInteger: 9007199254740991,
});

/** A request (EM11). */
export interface RequestMessage {
	readonly operationCall: 1;
	readonly type: "request";
	readonly invocation: string;
	readonly attempt: string;
	readonly operation: string;
	readonly input: JsonValue;
}

/** The end of an invocation (EM11): answered, refused, or failed with a reason and AGP's code or null. */
export type EndMessage =
	| { readonly operationCall: 1; readonly type: "end"; readonly invocation: string; readonly attempt: string; readonly operation: string; readonly outcome: "answered"; readonly answer: JsonValue }
	| { readonly operationCall: 1; readonly type: "end"; readonly invocation: string; readonly attempt: string; readonly operation: string; readonly outcome: "refused"; readonly refusal: RefusalRecord }
	| { readonly operationCall: 1; readonly type: "end"; readonly invocation: string; readonly attempt: string; readonly operation: string; readonly outcome: "failed"; readonly reason: FailedReason; readonly agpCode: string | null };

/** One ordered part of an answer (EM11); the format admits it, and no operation of the first version sends one. */
export interface PartMessage {
	readonly operationCall: 1;
	readonly type: "part";
	readonly invocation: string;
	readonly attempt: string;
	readonly operation: string;
	readonly sequence: number;
	readonly answer: JsonValue;
}

/** Any message of operation-call's format. */
export type OperationCallMessage = RequestMessage | EndMessage | PartMessage;

/**
 * Why an operation's invocation failed rather than ending answered or refused (EM11): `operation-failed` when
 * the operation threw, returned what is neither an answer nor a refusal in EM9's form, or the host's evidence
 * port failed for its request; `answer-not-sendable` when its answer could not cross AGP.
 */
export type FailedReason = "operation-failed" | "answer-not-sendable";

/** Who a message belongs to: its invocation, its attempt and its operation. */
export interface MessageAddress {
	readonly invocation: string;
	readonly attempt: string;
	readonly operation: string;
}

/** What an end message says, besides its address. */
export type EndContent =
	| { readonly outcome: "answered"; readonly answer: JsonValue }
	| { readonly outcome: "refused"; readonly refusal: RefusalRecord }
	| { readonly outcome: "failed"; readonly reason: FailedReason; readonly agpCode: string | null };

/** Writes a request message. */
export function writeRequest(address: MessageAddress, input: JsonValue): RequestMessage {
	return { operationCall: 1, type: "request", invocation: address.invocation, attempt: address.attempt, operation: address.operation, input };
}

/** Writes an end message, its fields in the order EM11 lists them. */
export function writeEnd(address: MessageAddress, content: EndContent): EndMessage {
	const head = { operationCall: 1, type: "end", invocation: address.invocation, attempt: address.attempt, operation: address.operation } as const;
	switch (content.outcome) {
		case "answered": return { ...head, outcome: "answered", answer: content.answer };
		case "refused": return { ...head, outcome: "refused", refusal: content.refusal };
		case "failed": return { ...head, outcome: "failed", reason: content.reason, agpCode: content.agpCode };
	}
}

/** Writes a part message. */
export function writePart(address: MessageAddress, sequence: number, answer: JsonValue): PartMessage {
	return { operationCall: 1, type: "part", invocation: address.invocation, attempt: address.attempt, operation: address.operation, sequence, answer };
}

/** True when an object holds exactly the names given, in any order. */
function hasExactly(value: { readonly [name: string]: unknown }, names: readonly string[]): boolean {
	const own = Object.keys(value);
	return own.length === names.length && names.every((n) => Object.hasOwn(value, n));
}

const HEAD = ["operationCall", "type", "invocation", "attempt", "operation"];

/**
 * Reads a value as a message of operation-call's format, returning it when it has exactly the form its
 * type names, and undefined otherwise. The attempt must hold the invocation, as EM11 writes it.
 */
function isJsonObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readMessage(rawValue: unknown): OperationCallMessage | undefined {
	const plain = readPlainJson(rawValue);
	if (!plain.ok || !isJsonObject(plain.value)) return undefined;
	const value = plain.value;
	if (value.operationCall !== 1 || !isInvocationId(value.invocation) || !isAttemptId(value.attempt)) return undefined;
	if (invocationOfAttempt(value.attempt) !== value.invocation || !isName(value.operation)) return undefined;
	switch (value.type) {
		case "request":
			return hasExactly(value, [...HEAD, "input"]) ? value as unknown as RequestMessage : undefined;
		case "part":
			return hasExactly(value, [...HEAD, "sequence", "answer"]) && Number.isSafeInteger(value.sequence) && (value.sequence as number) >= 1
				? value as unknown as PartMessage : undefined;
		case "end":
			switch (value.outcome) {
				case "answered": return hasExactly(value, [...HEAD, "outcome", "answer"]) ? value as unknown as EndMessage : undefined;
				case "refused": return hasExactly(value, [...HEAD, "outcome", "refusal"]) && isRefusalRecord(value.refusal) ? value as unknown as EndMessage : undefined;
				case "failed":
					return hasExactly(value, [...HEAD, "outcome", "reason", "agpCode"])
						&& (value.reason === "operation-failed" || value.reason === "answer-not-sendable")
						&& (value.agpCode === null || typeof value.agpCode === "string")
						? value as unknown as EndMessage : undefined;
				default: return undefined;
			}
		default: return undefined;
	}
}

/**
 * True when a message of JSON values crosses AGP whole by EM11's numeric and depth rules: it nests at most
 * 30 levels, the message itself the first, and every integer in it lies within 9007199254740991 of zero.
 */
export function crossesAgp(message: JsonValue): boolean {
	return nestingDepth(message) <= MESSAGE_LIMITS.depth && firstUnsafeInteger(message) === null;
}

/** The size of a message as JSON in UTF-8, as it is sent (EM11). */
export function messageBytes(message: JsonValue): number {
	return utf8ByteLength(toCanonicalJson(message));
}

/**
 * True when a request may be sent (EM11): it crosses AGP whole and its message is at most 16777216 bytes
 * as JSON in UTF-8. A request that is not is refused as `not-sendable` before it is sent. The depth is
 * measured first, so a request of any depth is judged without being written out.
 */
export function requestSendable(message: RequestMessage): boolean {
	return crossesAgp(message as unknown as JsonValue) && messageBytes(message as unknown as JsonValue) <= MESSAGE_LIMITS.requestBytes;
}
