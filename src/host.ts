/**
 * The host half (zorg's target, EM10, EM11 and EM13): serve declared operations by name, each at its own AGP
 * endpoint `<service>/<operation>`, and give every request exactly one end message, even when the operation
 * fails.
 *
 * For each request as it arrives, the host reads it and records it when well formed (below), then asks the
 * evidence function the host supplied (in zorg, caller-identity's answer) before acting on it: a request that
 * breaks EM11's form, or names an operation other than its endpoint's, is then refused as `malformed-request`
 * when its correlation label is an attempt identity, and discarded otherwise. Input that does not fit the declared shape is refused as `input-misfit`
 * with shape-check's misfit records unchanged, before the operation runs. The operation answers or refuses;
 * one that throws, or returns what is neither an answer nor a refusal in EM9's form, ends `failed` with
 * `operation-failed`, as does a request for which the evidence function fails. Reading what the operation
 * returned is inside that boundary: a getter or a proxy that throws on its result, or nested in its refusal
 * or answer, ends it so too, and the result is read once, into the copy that is judged and sent. An answer that cannot cross AGP whole, or whose send
 * AGP refuses, is replaced by a `failed` end with `answer-not-sendable` and AGP's code, or null when the host
 * found it unsendable itself; when that cannot be sent either, nothing is sent. Every answer goes to the
 * request's source endpoint, pinned to its origin node, under the request's attempt identity.
 *
 * Answers in parts and cancelling (EM11; zorg's D64): the host reads each message first and records a request
 * - its attempt, operation, origin node and `aliveWithinMs` - before asking the evidence port, so a `cancel`
 * or a caller's `alive` that follows it is taken whatever the evidence wait. A `cancel` fires the invocation's
 * signal; for a request carrying `aliveWithinMs`, so does a liveness deadline of twice `aliveWithinMs` passing
 * with no caller's `alive` taken, and the host submits its own `alive` every `aliveWithinMs` without a part. An
 * operation declared in parts is given `part(answer)`, whose parts go one at a time in call order; a part or
 * an `alive` that cannot be sent ends the invocation failed. Every end waits for the last submitted part, and
 * holds `parts`, the parts admitted, when the request carried `aliveWithinMs`. A request is finished once the
 * host's last send for it has settled, and the host then drops its record and stops its timers.
 */
import type { AgpNode, DirectPeerDeliveryContext, EndpointBinding, EndpointName, JsonObject } from "@agp/node";
import { observePromises, prepareShapeDocument, readPlainJson, snapshotJson, type JsonInput, type JsonValue, type PreparedShape } from "@apnex/shape-check";
import { systemCallClock, type CallClock, type ClockTimer } from "./system-ports.js";
import { checkDeclarationForm, describe, DESCRIBE_INPUT, hostRefusal, judgeDeclaration, nameDetails, type Description, type DescribedOperation, type HostRefusal, type OperationDeclaration } from "./declarations.js";
import { crossesAgp, readMessage, writeAlive, writeEnd, writePart, type EndContent, type MessageAddress, type RequestMessage } from "./message-format.js";
import { DESCRIBE_OPERATION, invocationOfAttempt, isAttemptId, isName } from "./names.js";
import { inputMisfit, malformedRequest, readRefusalRecord, type RefusalRecord } from "./refusal.js";

/** AGP's context for a delivered request: its message, correlation, source, ingress and session. */
export type DeliveryContext = Parameters<Parameters<AgpNode["expose"]>[1]>[1]["delivery"];

/** The host's evidence port: given a request's delivery context as it arrives, the evidence of who is calling. */
export type EvidenceFunction = (delivery: DeliveryContext) => unknown;

/** The peer authorization association mode required on incoming deliveries' directPeer targets (zorg's D75). */
export type HostMode = "unauthenticated" | "authenticated";

/** The minimum transport protection required on `node.sendDirectPeer` replies (zorg's D75). */
export type HostMinimumProtection = "none" | "integrity" | "confidentiality-and-integrity";

/** What a host is opened with. */
export interface HostOptions {
	/** The name the host serves under, matching EM1's pattern; its operations are `<service>/<operation>`. */
	readonly service: string;
	/** Asked for each message but a `cancel` or an `alive` as it arrives; its answer is the operation's `evidence`. Null when absent. */
	readonly evidence?: EvidenceFunction;
	/** The clock the host's signs of life run on (EM11); operation-call's default when absent. */
	readonly clock?: CallClock;
	/** Required direct-peer authorization association mode (`"unauthenticated"` when absent; zorg's D75). */
	readonly mode?: HostMode;
	/** Minimum transport protection on `node.sendDirectPeer` replies (`"confidentiality-and-integrity"` when mode is `"authenticated"`, `"none"` when `"unauthenticated"`; zorg's D75). */
	readonly minimumProtection?: HostMinimumProtection;
}

/** What an operation is given beside its input. */
export interface OperationContext {
	readonly service: string;
	readonly operation: string;
	/** The invocation identity, the same for every attempt of the invocation (`invocation-identity`). */
	readonly invocation: string;
	readonly attempt: string;
	/** AGP's delivery context for the request, as AGP gave it (`peer-identity-evidence`). */
	readonly delivery: DeliveryContext;
	/** The evidence function's answer for this request, or null when the host supplied none. */
	readonly evidence: unknown;
	/**
	 * The invocation's signal: it fires when the node stops, when the caller cancels, when a request carrying
	 * `aliveWithinMs` has had no caller's `alive` for twice that long, and when a part or an `alive` cannot be
	 * sent (EM11).
	 */
	readonly signal: AbortSignal;
	/**
	 * For an operation declared `answers: "parts"`: sends an answer as the next part (EM11), resolving true once
	 * AGP admits it and false when it cannot be sent, or once the signal has fired or the end has been decided.
	 */
	readonly part?: (answer: JsonInput) => Promise<boolean>;
}

/** How an operation ends an invocation: it answers, or it refuses with a refusal record (EM9). */
export type OperationResult =
	| { readonly outcome: "answered"; readonly answer: JsonInput }
	| { readonly outcome: "refused"; readonly refusal: RefusalRecord };

/** An operation: given input that fits its declared shape, it answers or refuses. */
export type OperationHandler = (input: JsonValue, context: OperationContext) => OperationResult | Promise<OperationResult>;

/** Whether a declaration took effect. */
export type DeclarationOutcome = { readonly declared: true } | { readonly declared: false; readonly refusal: HostRefusal };

/** A host serving operations under one name on one AGP node. */
export interface OperationHost {
	readonly service: string;
	/** Declares an operation and exposes its endpoint, or refuses as EM10 says, exposing nothing. */
	declare(declaration: OperationDeclaration, handler: OperationHandler): Promise<DeclarationOutcome>;
	/** The description `<service>/describe` answers. */
	description(): Description;
	/** Closes every endpoint the host exposed. */
	close(): Promise<void>;
}

/** Whether a host opened. */
export type HostOpening = { readonly opened: true; readonly host: OperationHost } | { readonly opened: false; readonly refusal: HostRefusal };

/** One operation the host serves. */
interface Served {
	readonly name: string;
	readonly prepared: PreparedShape & { accepted: true };
	readonly handler: OperationHandler;
	/** True for an operation declared `answers: "parts"`. */
	readonly parts: boolean;
}

/** What the host keeps of a request it recorded, until the request is finished (EM11). */
interface Recorded {
	readonly operation: string;
	readonly invocation: string;
	readonly origin: string;
	readonly aliveWithinMs: number | undefined;
	/** Fires the invocation's signal: a cancel, a lapsed liveness, a part or alive that could not be sent. */
	readonly controller: AbortController;
	/** The liveness deadline on the host's clock, for a request carrying `aliveWithinMs`. */
	liveUntil: number;
	/** When the host last submitted a part or an `alive` for the request, or made the record. */
	lastSubmitted: number;
	livenessTimer: ClockTimer | undefined;
	aliveTimer: ClockTimer | undefined;
	/** Parts submitted and parts admitted. */
	submitted: number;
	admitted: number;
	/** Parts called and not yet submitted, in call order, each with what it resolves. */
	readonly queue: { readonly reading: ReturnType<typeof readPlainJson>; readonly resolve: (sent: boolean) => void }[];
	/** The part submitted and not yet settled, if any; the end waits for it. */
	inFlight: Promise<void> | undefined;
	/** True once the end is decided: the operation returned, or the request ended without running it. */
	endDecided: boolean;
	/** True once the end is submitted: the host's alive goes on until then (EM11). */
	endSubmitted: boolean;
	/** The failure a part or an alive that could not be sent selected, which the end then is. */
	failure: EndContent | undefined;
	/** Resolves once a failure is selected. */
	readonly failed: Promise<void>;
	readonly fail: () => void;
	finished: boolean;
}

/**
 * The end content for what an operation returned (EM11): its answer or its refusal, `operation-failed` for
 * what is neither in EM9's form, and `answer-not-sendable` for an answer that is not JSON. Each property is
 * read once and copied, and what is judged and sent is the copy. Reading a result is part of the operation:
 * a getter or a proxy that throws throws from here, and the caller ends the invocation `operation-failed`.
 */
/**
 * Awaits a callback's return value only when it is a native `Promise` (zorg's D54, D55): a non-native
 * thenable is not awaited. Any synchronous throw, `Proxy` trap throw on `instanceof Promise`, attachment
 * throw, or rejection has its native promises observed and returns `{ ok: false }`.
 */
async function awaitNativePromise(fn: () => unknown): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false }> {
	let raw: unknown;
	try {
		raw = fn();
	} catch (error) {
		observePromises(error);
		return { ok: false };
	}
	let native = false;
	try {
		native = raw instanceof Promise;
	} catch (error) {
		observePromises(error);
		observePromises(raw);
		return { ok: false };
	}
	if (!native) return { ok: true, value: raw };
	try {
		return await (Reflect.apply(Promise.prototype.then, raw, [
			(resolved: unknown) => ({ ok: true as const, value: resolved }),
			(error: unknown) => {
				observePromises(error);
				return { ok: false as const };
			},
		]) as Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false }>);
	} catch (error) {
		observePromises(error);
		observePromises(raw);
		return { ok: false };
	}
}

function resultContent(value: unknown): EndContent {
	const failed: EndContent = { outcome: "failed", reason: "operation-failed", agpCode: null };
	const reading = readPlainJson(value);
	if (!reading.ok || reading.value === null || typeof reading.value !== "object" || Array.isArray(reading.value)) return failed;
	const plain = reading.value as { readonly [name: string]: JsonValue };
	const names = Object.keys(plain);
	if (names.length !== 2) return failed;
	if (plain.outcome === "answered" && Object.hasOwn(plain, "answer")) {
		return { outcome: "answered", answer: plain.answer as JsonValue };
	}
	if (plain.outcome === "refused" && Object.hasOwn(plain, "refusal")) {
		const refusal = readRefusalRecord(plain.refusal);
		return refusal.ok ? { outcome: "refused", refusal: refusal.refusal } : failed;
	}
	return failed;
}

function captureEligibleDirectPeer(to: DeliveryContext, hostMode: HostMode): DirectPeerDeliveryContext | null {
	if (to === null || typeof to !== "object") return null;
	let rawDirectPeer: unknown;
	try {
		const desc = Object.getOwnPropertyDescriptor(to, "directPeer");
		if (desc === undefined || !Object.hasOwn(desc, "value") || desc.enumerable !== true) return null;
		rawDirectPeer = desc.value;
	} catch (error) {
		observePromises(error);
		return null;
	}
	const reading = readPlainJson(rawDirectPeer);
	if (!reading.ok || reading.value === null || typeof reading.value !== "object" || Array.isArray(reading.value)) return null;
	const plain = reading.value as { readonly [name: string]: JsonValue };
	const keys = Object.keys(plain);
	if (keys.length !== 2 || !Object.hasOwn(plain, "originNodeId") || !Object.hasOwn(plain, "authorizationAssociation")) return null;
	const originNodeId = plain.originNodeId;
	let sourceOrigin: unknown;
	try {
		sourceOrigin = to.source?.originNodeId;
	} catch (error) {
		observePromises(error);
		return null;
	}
	if (typeof originNodeId !== "string" || originNodeId.length === 0 || originNodeId !== sourceOrigin) return null;
	const assoc = plain.authorizationAssociation;
	if (assoc === null || typeof assoc !== "object" || Array.isArray(assoc)) return null;
	const assocRec = assoc as { readonly [name: string]: JsonValue };
	const assocKeys = Object.keys(assocRec);
	if (assocRec.mode !== hostMode) return null;
	if (hostMode === "unauthenticated") {
		if (assocKeys.length !== 1) return null;
	} else {
		if (assocKeys.length !== 4) return null;
		if (typeof assocRec.issuer !== "string" || assocRec.issuer.length === 0) return null;
		if (typeof assocRec.principal !== "string" || assocRec.principal.length === 0) return null;
		if (typeof assocRec.instanceBinding !== "string" || assocRec.instanceBinding.length === 0) return null;
	}
	return plain as unknown as DirectPeerDeliveryContext;
}

/** Opens a host under a name on an AGP node, exposing `<service>/describe`, or refuses an invalid name. */
export async function createOperationHost(node: AgpNode, options: HostOptions): Promise<HostOpening> {
	if (!node || typeof node.expose !== "function" || typeof node.sendDirectPeer !== "function") throw new TypeError("createOperationHost needs an AGP node with sendDirectPeer");
	if (options === null || typeof options !== "object") throw new TypeError("createOperationHost needs { service }");
	let service: unknown;
	let evidence: HostOptions["evidence"];
	let rawClock: HostOptions["clock"];
	let rawMode: unknown;
	let rawMinimumProtection: unknown;
	try {
		service = options.service;
		evidence = options.evidence;
		rawClock = options.clock;
		rawMode = options.mode;
		rawMinimumProtection = options.minimumProtection;
	} catch (error) {
		observePromises(error);
		throw error;
	}
	if (evidence !== undefined && typeof evidence !== "function") throw new TypeError("a host's evidence is a function of the delivery context");
	if (typeof service !== "string") throw new TypeError("a host's service is a string");
	if (rawMode !== undefined && rawMode !== "unauthenticated" && rawMode !== "authenticated") {
		observePromises(rawMode);
		throw new TypeError("a host's mode is \"unauthenticated\" or \"authenticated\"");
	}
	const hostMode: HostMode = rawMode ?? "unauthenticated";
	if (rawMinimumProtection !== undefined && rawMinimumProtection !== "none" && rawMinimumProtection !== "integrity" && rawMinimumProtection !== "confidentiality-and-integrity") {
		observePromises(rawMinimumProtection);
		throw new TypeError("a host's minimumProtection is \"none\", \"integrity\" or \"confidentiality-and-integrity\"");
	}
	const minimumProtection: HostMinimumProtection = rawMinimumProtection ?? (hostMode === "authenticated" ? "confidentiality-and-integrity" : "none");
	if (!isName(service)) return { opened: false, refusal: hostRefusal("invalid-name", "A host serves under a name matching ^[a-z0-9][a-z0-9-]{0,62}$.", nameDetails(service)) };

	const declared: DescribedOperation[] = [];
	const bindings: EndpointBinding[] = [];
	const served = new Set<string>();
	let closed = false;
	let queue: Promise<unknown> = Promise.resolve();

	const clock = rawClock ?? systemCallClock;
	if (typeof clock.now !== "function" || typeof clock.schedule !== "function") throw new TypeError("a host's clock offers now and schedule");
	/** The requests recorded and not yet finished, by attempt identity (EM11). */
	const records = new Map<string, Recorded>();

	/** Reads the host's clock; a reading it cannot give is taken as the last time known, here 0 as the floor. */
	const now = (): number => {
		const reading = clock.now();
		if (typeof reading !== "number" || !Number.isFinite(reading)) throw new TypeError(`the host's clock read ${String(reading)}, not a finite number of milliseconds`);
		return reading;
	};

	/** Sends a message from an operation's endpoint to the request's source endpoint over its direct peer channel, under its label. */
	const sendTo = (operationName: string, to: DeliveryContext, target: DirectPeerDeliveryContext, message: JsonValue): Promise<unknown> => node.sendDirectPeer(`${service}/${operationName}` as EndpointName, to.source.endpoint, message as JsonObject, {
		target,
		minimumProtection,
		...(to.correlationId === undefined ? {} : { correlationId: to.correlationId }),
	});

	/** Sends an end message for a request, with `parts` when given; an answer or refusal that cannot be sent becomes a failed end, sent once, and an ineligible directPeer target sends nothing. */
	const reply = async (address: MessageAddress, content: EndContent, to: DeliveryContext, target: DirectPeerDeliveryContext | null, parts?: number): Promise<void> => {
		if (target === null) return;
		const send = (message: JsonValue): Promise<unknown> => sendTo(address.operation, to, target, message);
		let message = writeEnd(address, content, parts) as unknown as JsonValue;
		if (content.outcome !== "failed" && !crossesAgp(message)) {
			message = writeEnd(address, { outcome: "failed", reason: "answer-not-sendable", agpCode: null }, parts) as unknown as JsonValue;
			content = { outcome: "failed", reason: "answer-not-sendable", agpCode: null };
		}
		try {
			await send(message);
		} catch (error) {
			if (content.outcome === "failed") return;
			const code = (error as { code?: unknown } | null)?.code;
			const agpCode = typeof code === "string" ? code : null;
			await send(writeEnd(address, { outcome: "failed", reason: "answer-not-sendable", agpCode }, parts) as unknown as JsonValue).catch(() => undefined);
		}
	};

	/** Finishes a request: its record dropped, its timers stopped, no later cancel or alive taken (EM11). */
	const finish = (label: string | undefined, record: Recorded | undefined): void => {
		if (record === undefined || record.finished) return;
		record.finished = true;
		if (label !== undefined && records.get(label) === record) records.delete(label);
		for (const pending of [record.livenessTimer, record.aliveTimer]) {
			if (pending === undefined) continue;
			try {
				pending.cancel();
			} catch {
				// A timer that still runs finds the request finished.
			}
		}
	};

	/**
	 * Selects a failure for an invocation whose part or alive could not be sent, and fires its signal (EM11).
	 * A refused part fails it even once the end is decided, since the end waits for that part; an alive refused then changes nothing.
	 */
	const selectFailure = (record: Recorded, agpCode: string | null, unsent: "part" | "alive"): void => {
		if (record.failure !== undefined || (unsent === "alive" && record.endDecided)) return;
		record.failure = { outcome: "failed", reason: "answer-not-sendable", agpCode };
		record.controller.abort(new Error("a part or an alive of the invocation could not be sent"));
		record.fail();
	};

	/** True once the invocation's signal has fired or its end is decided: no part or alive goes after it. */
	const stopped = (record: Recorded, signal: AbortSignal): boolean => record.endDecided || record.failure !== undefined || signal.aborted;

	/** Watches a request's liveness deadline, firing its signal for good once the host's clock reads it (EM11). */
	const watchLiveness = (record: Recorded): void => {
		const check = (): void => {
			if (record.finished || record.controller.signal.aborted) return;
			let remaining: number;
			try {
				remaining = record.liveUntil - now();
			} catch {
				remaining = 0;
			}
			if (remaining <= 0) {
				record.controller.abort(new Error("the caller sent no alive for twice aliveWithinMs"));
				return;
			}
			try {
				record.livenessTimer = clock.schedule(Math.ceil(remaining), check);
			} catch {
				record.controller.abort(new Error("the host's clock could not schedule the liveness deadline"));
			}
		};
		try {
			record.livenessTimer = clock.schedule(2 * (record.aliveWithinMs as number), check);
		} catch {
			record.controller.abort(new Error("the host's clock could not schedule the liveness deadline"));
		}
	};

	/** Submits the host's alive whenever aliveWithinMs passes without a part or alive submitted (EM11). */
	const beat = (record: Recorded, to: DeliveryContext, target: DirectPeerDeliveryContext | null, address: MessageAddress, signal: AbortSignal): void => {
		const every = record.aliveWithinMs as number;
		const due = (): void => {
			// The host's alive goes on until it submits the end or the signal fires, the wait for a part included (EM11).
			if (record.finished || record.endSubmitted || signal.aborted) return;
			let at: number;
			try {
				at = now();
			} catch {
				at = record.lastSubmitted + every;
			}
			const remaining = record.lastSubmitted + every - at;
			if (remaining <= 0) {
				record.lastSubmitted = at;
				if (target === null) {
					selectFailure(record, null, "alive");
				} else {
					Promise.resolve(sendTo(address.operation, to, target, writeAlive(address) as unknown as JsonValue)).catch((error: unknown) => {
						// An alive refused before the end is decided ends the invocation failed; after it, nothing.
						const code = (error as { code?: unknown } | null)?.code;
						selectFailure(record, typeof code === "string" ? code : null, "alive");
					});
				}
			}
			try {
				record.aliveTimer = clock.schedule(remaining <= 0 ? every : Math.ceil(remaining), due);
			} catch {
				// A clock that cannot schedule sends no more alive; the caller's bound tells it.
			}
		};
		try {
			record.aliveTimer = clock.schedule(every, due);
		} catch {
			// As above.
		}
	};

	/** Records a request before the evidence port is asked (EM11). */
	const recordRequest = (operation: Served, message: RequestMessage, delivery: DeliveryContext): Recorded => {
		let fail = (): void => undefined;
		const failed = new Promise<void>((resolve) => { fail = resolve; });
		let at = 0;
		try {
			at = now();
		} catch {
			// The record's time is unknown; its liveness counts from 0, as a clock that cannot be read shows nothing.
		}
		const aliveWithinMs = message.aliveWithinMs;
		const record: Recorded = {
			operation: operation.name, invocation: message.invocation, origin: delivery.source.originNodeId, aliveWithinMs,
			controller: new AbortController(), liveUntil: aliveWithinMs === undefined ? Number.POSITIVE_INFINITY : at + 2 * aliveWithinMs,
			lastSubmitted: at, livenessTimer: undefined, aliveTimer: undefined, submitted: 0, admitted: 0, queue: [], inFlight: undefined,
			endDecided: false, endSubmitted: false, failure: undefined, failed, fail, finished: false,
		};
		return record;
	};

	/** Takes a cancel or a caller's alive for a recorded request, or discards it (EM11). */
	const control = (operation: Served, message: ReturnType<typeof readMessage>, delivery: DeliveryContext): void => {
		const label = delivery.correlationId;
		if (message === undefined || (message.type !== "cancel" && message.type !== "alive") || message.attempt !== label) return;
		const record = records.get(label);
		if (record === undefined || record.finished || record.operation !== operation.name || message.operation !== operation.name
			|| message.invocation !== record.invocation || delivery.source.originNodeId !== record.origin) return;
		if (message.type === "cancel") {
			record.controller.abort(new Error("the caller cancelled the invocation"));
			return;
		}
		// A caller's alive taken before the liveness deadline moves it; one read at or after it is not taken (EM11).
		if (record.aliveWithinMs === undefined || record.controller.signal.aborted) return;
		let at: number;
		try {
			at = now();
		} catch {
			return;
		}
		if (at >= record.liveUntil) {
			record.controller.abort(new Error("the caller sent no alive for twice aliveWithinMs"));
			return;
		}
		record.liveUntil = at + 2 * record.aliveWithinMs;
	};

	/** Serves one message delivered to an operation's endpoint. */
	const serve = async (operation: Served, payload: JsonObject, delivery: DeliveryContext, agpSignal: AbortSignal): Promise<void> => {
		const label = delivery.correlationId;
		// The message is read first: a cancel or an alive goes to its record and asks nothing of the evidence port.
		const message = readMessage(payload);
		const type = (payload as { readonly type?: unknown } | null)?.type;
		if (type === "cancel" || type === "alive") return control(operation, message, delivery);
		const directPeerTarget = captureEligibleDirectPeer(delivery, hostMode);
		const wellFormed = message !== undefined && message.type === "request" && message.attempt === label && message.operation === operation.name;
		// A well-formed request is recorded before the evidence port is asked, unless its attempt already is.
		let record: Recorded | undefined;
		if (wellFormed && label !== undefined && !records.has(label)) {
			record = recordRequest(operation, message as RequestMessage, delivery);
			records.set(label, record);
		}
		const signal = record === undefined ? agpSignal : AbortSignal.any([agpSignal, record.controller.signal]);
		// The host's signs of life begin with the record, whatever the evidence wait (EM11).
		if (record !== undefined && record.aliveWithinMs !== undefined) {
			const request = message as RequestMessage;
			watchLiveness(record);
			beat(record, delivery, directPeerTarget, { invocation: request.invocation, attempt: request.attempt, operation: operation.name }, signal);
		}
		try {
			let evidenceAnswer: JsonValue = null;
			let evidenceFailed = false;
			if (evidence !== undefined) {
				const settled = await awaitNativePromise(() => evidence(delivery));
				if (!settled.ok) {
					evidenceFailed = true;
				} else {
					const plainEvidence = readPlainJson(settled.value);
					if (!plainEvidence.ok) evidenceFailed = true;
					else evidenceAnswer = plainEvidence.value;
				}
			}
			if (!wellFormed) {
				if (isAttemptId(label)) await reply({ invocation: invocationOfAttempt(label), attempt: label, operation: operation.name }, { outcome: "refused", refusal: malformedRequest() }, delivery, directPeerTarget);
				return;
			}
			const request = message as RequestMessage;
			const address: MessageAddress = { invocation: request.invocation, attempt: request.attempt, operation: operation.name };
			const counted = request.aliveWithinMs !== undefined;
			/** Sends the end once the last submitted part has settled, `parts` counting the admitted ones (EM11). */
			const end = async (content: EndContent): Promise<void> => {
				if (record !== undefined) {
					record.endDecided = true;
					flush(record);
					await record.inFlight;
					record.endSubmitted = true;
				}
				await reply(address, record?.failure ?? content, delivery, directPeerTarget, counted ? record?.admitted ?? 0 : undefined);
			};
			if (evidenceFailed) return await end({ outcome: "failed", reason: "operation-failed", agpCode: null });
			const verdict = operation.prepared.judge(request.input);
			if (verdict.verdict === "misfit") return await end({ outcome: "refused", refusal: inputMisfit(operation.name, verdict.misfits) });
			const part = operation.parts && record !== undefined ? partOf(record, address, delivery, directPeerTarget, signal) : undefined;
			const context = Object.freeze({ service, operation: operation.name, invocation: request.invocation, attempt: request.attempt, delivery, evidence: evidenceAnswer, signal, ...(part === undefined ? {} : { part }) });
			// Running the operation and reading what it returned as plain data are one failure boundary (EM11; D54, D55).
			const running = awaitNativePromise(() => operation.handler(request.input, context));
			const outcome = record === undefined ? await running : await Promise.race([running, record.failed.then(() => undefined)]);
			const content: EndContent = outcome === undefined ? (record?.failure as EndContent)
				: outcome.ok ? resultContent(outcome.value) : { outcome: "failed", reason: "operation-failed", agpCode: null };
			return await end(content);
		} finally {
			finish(label, record);
		}
	};

	/** Resolves every part still waiting unsubmitted as false: the signal fired, or the end is decided (EM11). */
	const flush = (record: Recorded): void => {
		for (const waiting of record.queue.splice(0)) waiting.resolve(false);
	};

	/** Submits the next waiting part once the one before it has settled, one at a time, in call order (EM11). */
	const pump = (record: Recorded, address: MessageAddress, to: DeliveryContext, target: DirectPeerDeliveryContext | null, signal: AbortSignal): void => {
		if (record.inFlight !== undefined) return;
		if (stopped(record, signal)) return flush(record);
		const next = record.queue.shift();
		if (next === undefined) return;
		const failNow = (): void => {
			selectFailure(record, null, "part");
			next.resolve(false);
			flush(record);
		};
		if (target === null || !next.reading.ok) return failNow();
		const message = writePart(address, record.submitted + 1, next.reading.value) as unknown as JsonValue;
		if (!crossesAgp(message)) return failNow();
		record.submitted++;
		try {
			record.lastSubmitted = now();
		} catch {
			// The alive's count goes on from the last time known.
		}
		record.inFlight = Promise.resolve(sendTo(address.operation, to, target, message)).then(() => {
			record.admitted++;
			next.resolve(true);
		}, (error: unknown) => {
			const code = (error as { code?: unknown } | null)?.code;
			selectFailure(record, typeof code === "string" ? code : null, "part");
			next.resolve(false);
			flush(record);
		}).finally(() => {
			record.inFlight = undefined;
			pump(record, address, to, target, signal);
		});
	};

	/** The `part` an operation in parts is given for one request (EM11). */
	const partOf = (record: Recorded, address: MessageAddress, to: DeliveryContext, target: DirectPeerDeliveryContext | null, signal: AbortSignal): ((answer: JsonInput) => Promise<boolean>) => {
		// A waiting part resolves false as soon as the signal fires.
		if (!signal.aborted) signal.addEventListener("abort", () => flush(record), { once: true });
		return (answer: JsonInput): Promise<boolean> => {
			if (stopped(record, signal)) return Promise.resolve(false);
			// The answer is read as plain data as `part` is called, so what the operation does with it later changes nothing.
			const reading = readPlainJson(answer);
			return new Promise<boolean>((resolve) => {
				record.queue.push({ reading, resolve });
				pump(record, address, to, target, signal);
			});
		};
	};

	const expose = async (operation: Served): Promise<void> => {
		bindings.push(await node.expose(`${service}/${operation.name}` as EndpointName, (payload, context) => serve(operation, payload, context.delivery, context.signal)));
	};

	const description = (): Description => describe(service, declared);
	const describeShape = prepareShapeDocument(DESCRIBE_INPUT);
	if (!describeShape.accepted) throw new Error("shape-check refused the describe input shape; this is a defect of operation-call");
	await expose({
		name: DESCRIBE_OPERATION,
		prepared: describeShape,
		handler: () => ({ outcome: "answered", answer: description() as unknown as JsonValue }),
		parts: false,
	});

	const declare = (declaration: OperationDeclaration, handler: OperationHandler): Promise<DeclarationOutcome> => {
		checkDeclarationForm(declaration);
		if (typeof handler !== "function") throw new TypeError("a declared operation needs its handler");
		if (closed) throw new Error("the host is closed");
		const run = queue.then(async (): Promise<DeclarationOutcome> => {
			const judged = judgeDeclaration(service, declaration, declared, served);
			if (!judged.accepted) return { declared: false, refusal: judged.refusal };
			served.add(judged.described.name);
			try {
				await expose({ name: judged.described.name, prepared: judged.prepared, handler, parts: judged.described.answers === "parts" });
			} catch (error) {
				served.delete(judged.described.name);
				throw error;
			}
			declared.push(judged.described);
			return { declared: true };
		});
		queue = run.catch(() => undefined);
		return run;
	};

	const host: OperationHost = Object.freeze({
		service,
		declare,
		description: () => (snapshotJson(description()) as { readonly ok: true; readonly value: JsonValue }).value as unknown as Description,
		async close(): Promise<void> {
			closed = true;
			await queue;
			await Promise.all(bindings.map((b) => b.close()));
			// Closing finishes every request still recorded (EM11).
			for (const [label, record] of [...records]) finish(label, record);
		},
	});
	return { opened: true, host };
}
