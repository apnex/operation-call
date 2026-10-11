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
import type { CallEnding, CallRequest, DeliveryReport, OperationCaller } from "./call-types.js";
import { isJson, type JsonValue } from "./json-value.js";
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

/** Checks a call's arguments; a call that breaks them is the caller's programming error, not an ending. */
function checkCall(call: CallRequest): void {
	if (call === null || typeof call !== "object") throw new TypeError("invoke needs a call: { host, service, operation, input, bound }");
	if (typeof call.host !== "string" || call.host.length === 0) throw new TypeError("a call names the host it means as an AGP node identifier");
	if (!isName(call.service)) throw new TypeError("a call's service must match ^[a-z0-9][a-z0-9-]{0,62}$");
	if (!isName(call.operation)) throw new TypeError("a call's operation must match ^[a-z0-9][a-z0-9-]{0,62}$");
	if (!isJson(call.input)) throw new TypeError("a call's input must be a JSON value");
	if (!Number.isInteger(call.bound) || call.bound < 1 || call.bound > MAX_BOUND_MS) throw new RangeError("a call's bound is a whole number of milliseconds from 1 to 2147483647");
	if (call.invocation !== undefined && !isInvocationId(call.invocation)) throw new TypeError("a call's invocation must be an invocation identity as EM11 writes it");
	if (call.repeat !== undefined && typeof call.repeat !== "boolean") throw new TypeError("a call's repeat flag is true or false");
	if (call.signal !== undefined && (call.signal === null || typeof call.signal.aborted !== "boolean")) throw new TypeError("a call's signal must be an AbortSignal");
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

	const invoke = async (call: CallRequest): Promise<CallEnding> => {
		// The bound starts when the caller invokes (EM12): its deadline is read before anything else is done.
		const start = read();
		checkCall(call);
		const deadline = start + call.bound;
		const invocation = call.invocation ?? makeInvocationId(identities);
		const attempt = makeAttemptId(identities, invocation);
		const operation = call.operation;
		const address = { invocation, attempt, operation };
		const request = writeRequest(address, call.input as JsonValue);
		const sendable = requestSendable(request);
		// Prepared: the call's clock is read first, so a bound that passed while preparing wins, and nothing is sent.
		const left = deadline - read();
		if (left <= 0) return Object.freeze({ ending: "unknown", ...address, reason: "bound-passed", agpCode: null, deliveryReport: null });
		if (!sendable) return Object.freeze({ ending: "refused", ...address, refusal: notSendable() });
		const repeat = call.repeat === true;
		const endpoint = `${call.service}/${operation}`;

		/** True once the bound has passed on the call's clock; a reading the port cannot give shows nothing passed. */
		const boundPassed = (): boolean => {
			try {
				return read() >= deadline;
			} catch {
				return false;
			}
		};

		return new Promise<CallEnding>((resolve) => {
			let decided = false;
			let lastReport: DeliveryReport | null = null;
			let timer: ClockTimer | undefined;
			/** Settles the chosen ending; cancelling the bound's timer comes after, and its failure changes nothing. */
			const settle = (ending: CallEnding): void => {
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
			const observed = (ending: () => CallEnding): void => {
				if (decided) return;
				if (boundPassed()) atBound();
				else settle(ending());
			};
			const notDelivered = (agpCode: string): CallEnding =>
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

			// A port that cannot schedule the bound is a fault of the port: invoke rejects, and nothing is sent.
			timer = clock.schedule(left, () => {
				if (!decided) atBound();
			});
			if (decided) return;
			waiting.set(attempt, { invocation, operation, endpoint, host: call.host, take });
			let sending: Promise<{ readonly messageId: string }>;
			try {
				sending = node.send(REPLY_ENDPOINT as EndpointName, endpoint as EndpointName, request as unknown as JsonObject, {
					correlationId: attempt as never,
					// The time left, rounded up and at least 1 ms; the call's own bound still ends at its deadline.
					timeoutMs: Math.max(1, Math.ceil(left)),
					destinationSelector: { originNodeId: call.host as never, mode: "pinned" },
					...(call.signal === undefined ? {} : { signal: call.signal }),
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
