/**
 * The caller half (zorg's target, EM11 and EM12): invoke a named operation over AGP and give the
 * invocation exactly one honest ending within the bound the caller chose.
 *
 * Each invocation sends one attempt: a request from the reply endpoint `operation-call/replies` to
 * `<service>/<operation>`, pinned to the host the caller names, with the attempt identity as AGP's
 * correlation label, the time left on the bound as AGP's admission deadline, and the caller's abort signal
 * for the send alone. The first of these events decides the ending, and nothing after it changes it: AGP
 * rejects the send, or reports the request failed (not delivered, with AGP's code); an end message is taken
 * (answered, refused, or unknown when it failed); or the bound passes (unknown). A report of delivered or
 * unknown ends nothing.
 *
 * An event happens when it occurs on the call's clock, not when a callback for it runs (EM12). The bound's
 * absolute deadline is read as invoke is entered; after the synchronous preparation of the request, and at
 * every observation of AGP or of the reply endpoint, the call's clock is read first, so a bound already
 * passed decides the ending even when its own timer has not yet run. Choosing and settling the ending never
 * depends on the clock port's cleanup, and every reaction the caller leaves running handles its own
 * failure. Nothing here is particular to one runtime (zorg's D31).
 */
import type { AgpNode, EndpointName, JsonObject } from "@agp/node";
import type { CallLayerEnding, CallRequest, DeliveryReport, OperationCaller } from "./call-types.js";
import { snapshotJson } from "@apnex/shape-check";
import type { JsonValue } from "@apnex/shape-check";
import { readMessage, requestSendable, writeRequest, type EndMessage } from "./message-format.js";
import { isInvocationId, isName, makeAttemptId, makeInvocationId, REPLY_ENDPOINT, type IdentitySource } from "./names.js";
import { notSendable } from "./refusal.js";
import { systemCallClock, systemIdentitySource, type CallClock, type ClockTimer } from "./system-ports.js";

/** What AGP knows of the fate of one message it sent. */
type MessageDisposition = NonNullable<ReturnType<AgpNode["disposition"]>>;

/** The largest bound a caller may give, in milliseconds (EM12). */
export const MAX_BOUND_MS = 2147483647;

/** What a caller is built from. */
export interface CallerOptions {
	/** The caller's AGP node, created and not yet stopped; the caller exposes its reply endpoint there. */
	readonly node: AgpNode;
	/** The clock the bound runs on, apart from AGP's; `performance.now()` and `setTimeout` by default. */
	readonly clock?: CallClock;
	/** Where invocation and attempt identities take their time and randomness from. */
	readonly identities?: IdentitySource;
}

/** A caller over one AGP node. */
export interface Caller extends OperationCaller {
	/** Invokes a named operation; the call layer's own endings only, none a caller across a hop adds (EM12). */
	invoke(call: CallRequest): Promise<CallLayerEnding>;
	/** A new invocation identity, as EM11 writes it, for a caller that names its invocation before invoking. */
	newInvocation(): string;
	/** How many messages the reply endpoint has discarded because no waiting attempt could take them (EM11). */
	discarded(): number;
	/** Closes the reply endpoint; an invocation still waiting then ends at its bound. */
	close(): Promise<void>;
}

/** One attempt waiting for its ending. */
interface Waiting {
	readonly invocation: string;
	readonly operation: string;
	readonly endpoint: string;
	readonly host: string;
	/** Takes an end message the reply endpoint accepted for this attempt. */
	readonly take: (message: EndMessage) => void;
}

/** AGP's code from a rejected send; a rejection carrying none is recorded as `INTERNAL` (EM12). */
function agpCodeOf(error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" && code.length > 0 ? code : "INTERNAL";
}

/** A call request as `readCallRequest` gives it: each field read once and checked, and the input's snapshot. */
export interface ReadCallRequest {
	readonly host: string;
	readonly service: string;
	readonly operation: string;
	readonly input: JsonValue;
	readonly bound: number;
	readonly invocation: string | undefined;
	readonly repeat: boolean;
	readonly signal: AbortSignal | undefined;
}

/**
 * Reads a call request (EM12): `host`, `service`, `operation`, `bound`, `invocation`, `repeat` and `signal` at most
 * once each, and `input` once through shape-check's `snapshotJson`, so an accessor on the request or the input
 * is read now and never again. A call that breaks them is the caller's programming error, thrown as a
 * `RangeError` (the bound) or a `TypeError` (anything else), never an ending; an input accessor that throws is
 * such an error too. Gives the checked request, the caller's live abort signal kept as it was given.
 */
export function readCallRequest(call: CallRequest): ReadCallRequest {
	if (call === null || typeof call !== "object") throw new TypeError("invoke needs a call: { host, service, operation, input, bound }");
	const host: unknown = call.host;
	if (typeof host !== "string" || host.length === 0) throw new TypeError("a call names the host it means as an AGP node identifier");
	const service: unknown = call.service;
	if (!isName(service)) throw new TypeError("a call's service must match ^[a-z0-9][a-z0-9-]{0,62}$");
	const operation: unknown = call.operation;
	if (!isName(operation)) throw new TypeError("a call's operation must match ^[a-z0-9][a-z0-9-]{0,62}$");
	let snapshot: ReturnType<typeof snapshotJson>;
	try {
		snapshot = snapshotJson(call.input);
	} catch (error) {
		throw new TypeError("a call's input could not be read as a JSON value", { cause: error });
	}
	if (!snapshot.ok) throw new TypeError("a call's input must be a JSON value");
	const bound: unknown = call.bound;
	if (typeof bound !== "number" || !Number.isInteger(bound) || bound < 1 || bound > MAX_BOUND_MS) throw new RangeError("a call's bound is a whole number of milliseconds from 1 to 2147483647");
	const invocation: unknown = call.invocation;
	if (invocation !== undefined && !isInvocationId(invocation)) throw new TypeError("a call's invocation must be an invocation identity as EM11 writes it");
	const repeat: unknown = call.repeat;
	if (repeat !== undefined && typeof repeat !== "boolean") throw new TypeError("a call's repeat flag is true or false");
	const signal: unknown = call.signal;
	if (signal !== undefined && (signal === null || typeof (signal as { aborted?: unknown }).aborted !== "boolean")) throw new TypeError("a call's signal must be an AbortSignal");
	return Object.freeze({
		host,
		service,
		operation,
		input: snapshot.value,
		bound,
		invocation: invocation as string | undefined,
		repeat: repeat === true,
		signal: signal as AbortSignal | undefined,
	});
}

/** Builds a caller on an AGP node, exposing the reply endpoint `operation-call/replies` there. */
export async function createCaller(options: CallerOptions): Promise<Caller> {
	if (options === null || typeof options !== "object" || !options.node) throw new TypeError("createCaller needs { node }, an AGP node");
	const node = options.node;
	const clock = options.clock ?? systemCallClock;
	const identities = options.identities ?? systemIdentitySource;
	if (typeof clock.now !== "function" || typeof clock.schedule !== "function") throw new TypeError("a call clock offers now and schedule");
	const waiting = new Map<string, Waiting>();
	let discarded = 0;

	/** Reads the call's clock; a reading that is not a finite number is a fault of the port. */
	const read = (): number => {
		const now = clock.now();
		if (typeof now !== "number" || !Number.isFinite(now)) throw new TypeError(`the call clock read ${String(now)}, not a finite number of milliseconds`);
		return now;
	};

	const binding = await node.expose(REPLY_ENDPOINT as EndpointName, async (payload, context) => {
		const label = context.delivery.correlationId;
		const attempt = label === undefined ? undefined : waiting.get(label);
		const message = readMessage(payload);
		// Taken only in the form EM11 gives, under its own attempt's label, while that attempt waits, for its
		// invocation and operation, from the operation's endpoint on the node the attempt was pinned to.
		if (attempt === undefined || message === undefined || message.type !== "end" || message.attempt !== label
			|| message.invocation !== attempt.invocation || message.operation !== attempt.operation
			|| context.delivery.source.endpoint !== attempt.endpoint || context.delivery.source.originNodeId !== attempt.host) {
			discarded++;
			return;
		}
		attempt.take(message);
	});

	const invoke = async (call: CallRequest): Promise<CallLayerEnding> => {
		// The bound starts when the caller invokes (EM12): its deadline is read before anything else is done.
		const start = read();
		// Then each field of the request is read once, and only what was read is used from here on.
		const { host, service, operation, input, bound, repeat, signal, invocation: given } = readCallRequest(call);
		const deadline = start + bound;
		const invocation = given ?? makeInvocationId(identities);
		const attempt = makeAttemptId(identities, invocation);
		const address = { invocation, attempt, operation };
		const request = writeRequest(address, input);
		const sendable = requestSendable(request);
		// Prepared: the call's clock is read first, so a bound that passed while preparing wins, and nothing is sent.
		const left = deadline - read();
		if (left <= 0) return Object.freeze({ ending: "unknown", ...address, reason: "bound-passed", agpCode: null, deliveryReport: null });
		if (!sendable) return Object.freeze({ ending: "refused", ...address, refusal: notSendable() });
		const endpoint = `${service}/${operation}`;

		/** True once the bound has passed on the call's clock; a reading the port cannot give shows nothing passed. */
		const boundPassed = (): boolean => {
			try {
				return read() >= deadline;
			} catch {
				return false;
			}
		};

		return new Promise<CallLayerEnding>((resolve) => {
			let decided = false;
			let lastReport: DeliveryReport | null = null;
			let timer: ClockTimer | undefined;
			/** Settles the chosen ending; cancelling the bound's timer comes after, and its failure changes nothing. */
			const settle = (ending: CallLayerEnding): void => {
				decided = true;
				waiting.delete(attempt);
				resolve(Object.freeze(ending));
				if (timer === undefined) return;
				try {
					timer.cancel();
				} catch {
					// The ending is settled; a timer that still runs finds the invocation decided.
				}
			};
			const atBound = (): void => settle({ ending: "unknown", ...address, reason: "bound-passed", agpCode: null, deliveryReport: lastReport });
			/** An event observed now: when the bound has already passed on the call's clock, the bound came first. */
			const observed = (ending: () => CallLayerEnding): void => {
				if (decided) return;
				if (boundPassed()) atBound();
				else settle(ending());
			};
			const notDelivered = (agpCode: string): CallLayerEnding =>
				({ ending: "not-delivered", ...address, agpCode, proxyCode: null, earlierAttemptsUncertain: repeat });
			const observe = (disposition: MessageDisposition | undefined): void => {
				if (decided || disposition === undefined) return;
				if (boundPassed()) return atBound();
				for (const outcome of disposition.outcomes) {
					if (outcome.kind === "failed") return settle(notDelivered(outcome.code));
					lastReport = outcome.kind;
				}
			};
			const take = (message: EndMessage): void => observed(() => {
				const ending = { invocation: message.invocation, attempt: message.attempt, operation: message.operation };
				if (message.outcome === "answered") return { ending: "answered", ...ending, answer: message.answer };
				if (message.outcome === "refused") return { ending: "refused", ...ending, refusal: message.refusal };
				return { ending: "unknown", ...ending, reason: message.reason, agpCode: message.agpCode, deliveryReport: lastReport };
			});

			/**
			 * A wakeup of the bound's timer is not an event (EM12): the call's clock is read, and while the deadline
			 * has not passed on it the timer is set again for the time remaining, rounded up, and checked again.
			 * The call ends at its bound only once the clock shows the deadline passed. A clock that can no longer
			 * be read or schedule leaves nothing to wait on, so its timer's word is taken that the bound has passed.
			 */
			const wake = (): void => {
				if (decided) return;
				let remaining: number;
				try {
					remaining = deadline - read();
				} catch {
					return atBound();
				}
				if (remaining <= 0) return atBound();
				try {
					timer = clock.schedule(Math.ceil(remaining), wake);
				} catch {
					atBound();
				}
			};
			// A port that cannot schedule the bound is a fault of the port: invoke rejects, and nothing is sent.
			timer = clock.schedule(left, wake);
			if (decided) return;
			waiting.set(attempt, { invocation, operation, endpoint, host, take });
			let sending: Promise<{ readonly messageId: string }>;
			try {
				sending = node.send(REPLY_ENDPOINT as EndpointName, endpoint as EndpointName, request as unknown as JsonObject, {
					correlationId: attempt as never,
					// The time left, rounded up and at least 1 ms; the call's own bound still ends at its deadline.
					timeoutMs: Math.max(1, Math.ceil(left)),
					destinationSelector: { originNodeId: host as never, mode: "pinned" },
					...(signal === undefined ? {} : { signal }),
				});
			} catch (error) {
				sending = Promise.reject(error);
			}
			// A fault of AGP's port in these reactions leaves the bound to end the call; none goes unhandled.
			Promise.resolve(sending).then((receipt) => {
				if (decided) return;
				const id = receipt.messageId as never;
				observe(node.disposition(id));
				if (decided) return;
				Promise.resolve(node.settled(id)).then(observe).catch(() => undefined);
			}, (error: unknown) => observed(() => notDelivered(agpCodeOf(error)))).catch(() => undefined);
		});
	};

	return Object.freeze({
		invoke,
		newInvocation: () => makeInvocationId(identities),
		discarded: () => discarded,
		close: () => binding.close(),
	});
}
