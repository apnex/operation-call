/**
 * The caller's interface (zorg's target, EM12): what a caller asks, and how each invocation ends.
 *
 * Every invocation ends exactly once: answered, refused with a refusal record, not delivered - AGP refused
 * this attempt outright, or a caller across a hop handed nothing of it on, so it had no effect - or unknown.
 * operation-proxy's client half offers this same
 * interface (its `caller-interface-parity`), and its caller suite is written against it. The interface's types
 * admit what every implementation honestly gives - `attempt` null where no attempt of the call layer is known,
 * a `proxyCode` a caller across a hop names, and the reasons a hop adds - while operation-call's own caller
 * gives only the call layer's endings (`CallLayerEnding`), so it is assignable to the interface (EM12).
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

/** Why the call layer itself ended an invocation unknown (EM12). */
export type CallLayerUnknownReason = "bound-passed" | "operation-failed" | "answer-not-sendable";

/**
 * Why a caller across a hop ended an invocation unknown, where the hop lost certainty: the reasons a hop adds
 * (EM12; operation-proxy's PX6). operation-call's own caller never gives them.
 */
export type HopUnknownReason = "proxy-lost" | "hop-stalled";

/** Why an invocation ended unknown, through any implementation of the caller interface (EM12). */
export type UnknownReason = CallLayerUnknownReason | HopUnknownReason;

/**
 * The fields every ending carries: the invocation and attempt it ended, and the operation's name. `attempt` is
 * null where no attempt of the call layer is known - an ending a caller across a hop decided itself once its
 * own checks were done (EM12; operation-proxy's PX6); an ending of those checks names the attempt it made, as
 * operation-call's own caller always names its attempt (operation-proxy's PX5).
 */
export interface EndingAddress {
	readonly invocation: string;
	readonly attempt: string | null;
	readonly operation: string;
}

/** The address of an ending of the call layer, which always names the attempt it ended. */
export interface CallLayerAddress extends EndingAddress {
	readonly attempt: string;
}

/** The operation answered. */
export interface AnsweredEnding extends CallLayerAddress {
	readonly ending: "answered";
	readonly answer: JsonValue;
}

/** The invocation was refused: by the operation or its host, or by the caller before sending (EM9). */
export interface RefusedEnding extends CallLayerAddress {
	readonly ending: "refused";
	readonly refusal: RefusalRecord;
}

/** AGP refused this attempt outright, so this attempt had no effect (EM12; operation-call's D2). */
export interface CallLayerNotDeliveredEnding extends CallLayerAddress {
	readonly ending: "not-delivered";
	/** AGP's code, unchanged. */
	readonly agpCode: string;
	/** Always null from the call layer. */
	readonly proxyCode: null;
	/** True when the caller marked the invocation as a repeat: an earlier attempt may have taken effect. */
	readonly earlierAttemptsUncertain: boolean;
}

/**
 * A caller across a hop handed nothing of the invocation on, so it had no effect: the hop names its own code,
 * and no attempt of the call layer, and no AGP code, is known (EM12; operation-proxy's PX6).
 */
export interface HopNotDeliveredEnding extends EndingAddress {
	readonly ending: "not-delivered";
	readonly attempt: null;
	readonly agpCode: null;
	/** The code the caller across the hop names. */
	readonly proxyCode: string;
	/** True when the caller marked the invocation as a repeat: an earlier attempt may have taken effect. */
	readonly earlierAttemptsUncertain: boolean;
}

/** Nothing of this attempt had effect: AGP refused it outright, or a caller across a hop handed nothing on. */
export type NotDeliveredEnding = CallLayerNotDeliveredEnding | HopNotDeliveredEnding;

/** It may have reached the operation, and no answer came within the bound, or the operation failed. */
export interface CallLayerUnknownEnding extends CallLayerAddress {
	readonly ending: "unknown";
	readonly reason: CallLayerUnknownReason;
	/** The failed end message's AGP code, or null. */
	readonly agpCode: string | null;
	/** The last report of delivered or unknown AGP gave for the request, or null when it gave none. */
	readonly deliveryReport: DeliveryReport | null;
}

/**
 * A caller across a hop lost certainty after handing the invocation on: it may have reached the operation, and
 * no attempt of the call layer, AGP code or delivery report is known (EM12; operation-proxy's PX6).
 */
export interface HopUnknownEnding extends EndingAddress {
	readonly ending: "unknown";
	readonly attempt: null;
	readonly reason: HopUnknownReason;
	readonly agpCode: null;
	readonly deliveryReport: null;
}

/** It may have reached the operation, and how it ended is not known. */
export type UnknownEnding = CallLayerUnknownEnding | HopUnknownEnding;

/** How the call layer ends an invocation: what operation-call's own caller gives, and nothing more. */
export type CallLayerEnding = AnsweredEnding | RefusedEnding | CallLayerNotDeliveredEnding | CallLayerUnknownEnding;

/**
 * How an invocation ended, through any implementation of the caller interface: the call layer's endings, and
 * those a caller across a hop decides itself (EM12). Code written against this runs on any caller unchanged.
 */
export type CallEnding = CallLayerEnding | HopNotDeliveredEnding | HopUnknownEnding;

/**
 * The caller's interface: invoke a named operation and learn how the invocation ended. Its ending admits what
 * every implementation honestly gives (EM12); operation-call's own caller gives only a `CallLayerEnding`.
 */
export interface OperationCaller {
	invoke(call: CallRequest): Promise<CallEnding>;
}
