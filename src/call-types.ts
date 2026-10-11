/**
 * The caller's interface (zorg's target, EM12): what a caller asks, and how each invocation ends.
 *
 * Every invocation ends exactly once: answered, refused with a refusal record, not delivered - AGP refused
 * this attempt outright, so it had no effect - or unknown. operation-proxy's client half offers this same
 * interface (its `caller-interface-parity`), and its caller suite is written against it.
 */
import type { JsonInput, JsonValue } from "./json-value.js";
import type { RefusalRecord } from "./refusal.js";

/** One invocation, as a caller asks for it. */
export interface CallRequest {
	/** The AGP node of the host the caller means; every request is pinned to it (D7, EM11). */
	readonly host: string;
	/** The name the operation is served under, matching EM1's pattern. */
	readonly service: string;
	/** The operation's own name, matching EM1's pattern; the request goes to `<service>/<operation>`. */
	readonly operation: string;
	/** The input, any JSON value. */
	readonly input: JsonInput;
	/** The bound: a whole number of milliseconds from 1 to 2147483647, starting when the caller invokes. */
	readonly bound: number;
	/** The invocation identity to use, as EM11 writes it; a new one when absent. */
	readonly invocation?: string;
	/** Marks the invocation as a repeat of one that may have taken effect (operation-call's D2). */
	readonly repeat?: boolean;
	/** Passed to AGP for the send alone: an abort before AGP admits the send ends it not delivered. */
	readonly signal?: AbortSignal;
}

/** What AGP last reported of the request's delivery, when it reported delivered or unknown (EM12). */
export type DeliveryReport = "delivered" | "unknown";

/** Why an invocation ended unknown (EM12). */
export type UnknownReason = "bound-passed" | "operation-failed" | "answer-not-sendable";

/** The fields every ending carries: the invocation and attempt it ended, and the operation's name. */
export interface EndingAddress {
	readonly invocation: string;
	readonly attempt: string;
	readonly operation: string;
}

/** The operation answered. */
export interface AnsweredEnding extends EndingAddress {
	readonly ending: "answered";
	readonly answer: JsonValue;
}

/** The invocation was refused: by the operation or its host, or by the caller before sending (EM9). */
export interface RefusedEnding extends EndingAddress {
	readonly ending: "refused";
	readonly refusal: RefusalRecord;
}

/** AGP refused this attempt outright, so this attempt had no effect (EM12; operation-call's D2). */
export interface NotDeliveredEnding extends EndingAddress {
	readonly ending: "not-delivered";
	/** AGP's code, unchanged. */
	readonly agpCode: string;
	/** Always null from operation-call; a caller through operation-proxy names the proxy's code here (PX6). */
	readonly proxyCode: string | null;
	/** True when the caller marked the invocation as a repeat: an earlier attempt may have taken effect. */
	readonly earlierAttemptsUncertain: boolean;
}

/** It may have reached the operation, and no answer came within the bound, or the operation failed. */
export interface UnknownEnding extends EndingAddress {
	readonly ending: "unknown";
	readonly reason: UnknownReason;
	/** The failed end message's AGP code, or null. */
	readonly agpCode: string | null;
	/** The last report of delivered or unknown AGP gave for the request, or null when it gave none. */
	readonly deliveryReport: DeliveryReport | null;
}

/** How an invocation ended. */
export type CallEnding = AnsweredEnding | RefusedEnding | NotDeliveredEnding | UnknownEnding;

/** The caller's interface: invoke a named operation and learn how the invocation ended. */
export interface OperationCaller {
	invoke(call: CallRequest): Promise<CallEnding>;
}
