/**
 * operation-call's message format (zorg's target, EM11; zorg's D8, D9), exported as
 * `@apnex/operation-call/message-format` so another implementation of the caller's side - operation-proxy's
 * client half (its PX5) - applies the same checks and writes the same messages.
 *
 * Every message is a JSON object holding `operationCall`, which is 1, `type`, and exactly the fields its
 * type names: a `request`, with `aliveWithinMs` when its caller accepts parts; an `end`, answered, refused or
 * failed, with `parts` when its request carried `aliveWithinMs`; a `part`; an `alive`, sent by a host to its
 * caller and by a caller that accepts parts to the host; or a `cancel` (zorg's D9, amended by D64). Every
 * message must cross AGP whole: counting
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
	/** The largest `aliveWithinMs` a request carries: half of EM12's largest bound, rounded down. */
	aliveWithinMs: 1073741823,
});

/** A request (EM11), carrying `aliveWithinMs` exactly when its caller accepts parts (EM12). */
export interface RequestMessage {
	readonly operationCall: 1;
	readonly type: "request";
	readonly invocation: string;
	readonly attempt: string;
	readonly operation: string;
	readonly input: JsonValue;
	readonly aliveWithinMs?: number;
}

/**
 * The end of an invocation (EM11): answered, refused, or failed with a reason and AGP's code or null; with
 * `parts`, how many parts the host sent, exactly when the request it answers carried `aliveWithinMs`.
 */
export type EndMessage =
	| { readonly operationCall: 1; readonly type: "end"; readonly invocation: string; readonly attempt: string; readonly operation: string; readonly outcome: "answered"; readonly answer: JsonValue; readonly parts?: number }
	| { readonly operationCall: 1; readonly type: "end"; readonly invocation: string; readonly attempt: string; readonly operation: string; readonly outcome: "refused"; readonly refusal: RefusalRecord; readonly parts?: number }
	| { readonly operationCall: 1; readonly type: "end"; readonly invocation: string; readonly attempt: string; readonly operation: string; readonly outcome: "failed"; readonly reason: FailedReason; readonly agpCode: string | null; readonly parts?: number };

/** One ordered part of an answer (EM11), its `sequence` counting from 1 for each request. */
export interface PartMessage {
	readonly operationCall: 1;
	readonly type: "part";
	readonly invocation: string;
	readonly attempt: string;
	readonly operation: string;
	readonly sequence: number;
	readonly answer: JsonValue;
}

/** A sign of life (EM11, EM12): sent by a host to its caller, and by a caller that accepts parts to the host. */
export interface AliveMessage {
	readonly operationCall: 1;
	readonly type: "alive";
	readonly invocation: string;
	readonly attempt: string;
	readonly operation: string;
}

/** A caller's request that the host stop an invocation (EM11, EM12; `cancel-invocation`). */
export interface CancelMessage {
	readonly operationCall: 1;
	readonly type: "cancel";
	readonly invocation: string;
	readonly attempt: string;
	readonly operation: string;
}

/** Any message of operation-call's format. */
export type OperationCallMessage = RequestMessage | EndMessage | PartMessage | AliveMessage | CancelMessage;

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

/** Writes a request message, with `aliveWithinMs` when the caller accepts parts. */
export function writeRequest(address: MessageAddress, input: JsonValue, aliveWithinMs?: number): RequestMessage {
	const request = { operationCall: 1, type: "request", invocation: address.invocation, attempt: address.attempt, operation: address.operation, input } as const;
	return aliveWithinMs === undefined ? request : { ...request, aliveWithinMs };
}

/** Writes an end message, its fields in the order EM11 lists them, with `parts` when it is given. */
export function writeEnd(address: MessageAddress, content: EndContent, parts?: number): EndMessage {
	const head = { operationCall: 1, type: "end", invocation: address.invocation, attempt: address.attempt, operation: address.operation } as const;
	const counted = parts === undefined ? {} : { parts };
	switch (content.outcome) {
		case "answered": return { ...head, outcome: "answered", answer: content.answer, ...counted };
		case "refused": return { ...head, outcome: "refused", refusal: content.refusal, ...counted };
		case "failed": return { ...head, outcome: "failed", reason: content.reason, agpCode: content.agpCode, ...counted };
	}
}

/** Writes an `alive` message. */
export function writeAlive(address: MessageAddress): AliveMessage {
	return { operationCall: 1, type: "alive", invocation: address.invocation, attempt: address.attempt, operation: address.operation };
}

/** Writes a `cancel` message. */
export function writeCancel(address: MessageAddress): CancelMessage {
	return { operationCall: 1, type: "cancel", invocation: address.invocation, attempt: address.attempt, operation: address.operation };
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
		case "request": {
			if (!Object.hasOwn(value, "aliveWithinMs")) return hasExactly(value, [...HEAD, "input"]) ? value as unknown as RequestMessage : undefined;
			const alive = value.aliveWithinMs;
			return hasExactly(value, [...HEAD, "input", "aliveWithinMs"]) && Number.isSafeInteger(alive) && (alive as number) >= 1 && (alive as number) <= MESSAGE_LIMITS.aliveWithinMs
				? value as unknown as RequestMessage : undefined;
		}
		case "part":
			return hasExactly(value, [...HEAD, "sequence", "answer"]) && Number.isSafeInteger(value.sequence) && (value.sequence as number) >= 1
				? value as unknown as PartMessage : undefined;
		case "alive":
			return hasExactly(value, HEAD) ? value as unknown as AliveMessage : undefined;
		case "cancel":
			return hasExactly(value, HEAD) ? value as unknown as CancelMessage : undefined;
		case "end": {
			// `parts`, when present, is a whole number; whether it must be present is the reader's to judge (EM11).
			const counted = Object.hasOwn(value, "parts");
			if (counted && !(Number.isSafeInteger(value.parts) && (value.parts as number) >= 0)) return undefined;
			const tail = counted ? ["parts"] : [];
			switch (value.outcome) {
				case "answered": return hasExactly(value, [...HEAD, "outcome", "answer", ...tail]) ? value as unknown as EndMessage : undefined;
				case "refused": return hasExactly(value, [...HEAD, "outcome", "refusal", ...tail]) && isRefusalRecord(value.refusal) ? value as unknown as EndMessage : undefined;
				case "failed":
					return hasExactly(value, [...HEAD, "outcome", "reason", "agpCode", ...tail])
						&& (value.reason === "operation-failed" || value.reason === "answer-not-sendable")
						&& (value.agpCode === null || typeof value.agpCode === "string")
						? value as unknown as EndMessage : undefined;
				default: return undefined;
			}
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
