/**
 * The suite's fixture: on each of the session's two host nodes, an operation-call host serving the same
 * fixture operations under the name `fixture`, each recording every run, and helpers a case calls through.
 *
 * The fixture operations: `echo` answers its input unchanged; `which` answers the host's node and the
 * identities it was given; `hold` waits until the case releases that run, then answers like `which` with
 * its input; `silent` never answers; `deeper` answers its input one level deeper; `sized` answers a string
 * of `input.bytes` characters; `refuses` refuses with the refusal record its input holds; `throws` throws;
 * `strict` declares an input shape of `{"n": integer}` and answers its input.
 */
import type { CallEnding, CallRequest } from "../call-types.js";
import { createOperationHost, type OperationContext, type OperationHandler, type OperationHost } from "../host.js";
import type { JsonInput, JsonValue } from "../json-value.js";
import type { RefusalRecord } from "../refusal.js";
import { check, latch, same, turn, until, watch, type Latch, type Watched } from "./suite-check.js";
import type { CallerSuiteHarness, CallerSuiteHooks, CallerSuiteOpenOptions, CallerSuiteSession } from "./suite-types.js";

/** The name the fixture hosts serve under. */
export const SERVICE = "fixture";

/** The dialect every fixture shape declares. */
const DIALECT = "urn:apnex:shape-check:dialect:1";

/** One run of a fixture operation, as its host recorded it. */
export interface Run {
	readonly operation: string;
	readonly input: JsonValue;
	readonly invocation: string;
	readonly attempt: string;
	readonly correlationId: string | undefined;
	readonly origin: string;
}

/** One fixture host. */
export interface FixtureHost {
	readonly nodeId: string;
	readonly host: OperationHost;
	/** Every run of any fixture operation on this host, in order. */
	readonly runs: Run[];
	/** The latch of each run of `hold`, in order. */
	readonly holds: Latch[];
}

/** A case's context. */
export interface CaseContext {
	readonly session: CallerSuiteSession;
	readonly hooks: CallerSuiteHooks;
	readonly harness: CallerSuiteHarness;
	readonly a: FixtureHost;
	readonly b: FixtureHost;
	/** Invokes through the caller under test: host `a`, service `fixture`, input `{}` and a bound of 1000 ms unless given. */
	call(request: Partial<CallRequest> & { readonly operation: string }): Promise<CallEnding>;
	/** Invokes as `call` does, and waits a bounded time for the ending, failing rather than hanging without one. */
	ended(request: Partial<CallRequest> & { readonly operation: string }): Promise<CallEnding>;
}

/** Every fixture operation's name. */
export const FIXTURE_OPERATIONS = ["echo", "which", "hold", "silent", "deeper", "sized", "refuses", "throws", "strict"] as const;

/** Opens a fixture host on one node, declaring every fixture operation. */
async function openFixtureHost(nodeId: string, node: CallerSuiteSession["hosts"][number]["node"]): Promise<FixtureHost> {
	const opening = await createOperationHost(node, { service: SERVICE });
	check(opening.opened, `the fixture host on ${nodeId} opens`);
	const runs: Run[] = [];
	const holds: Latch[] = [];
	const record = (input: JsonValue, c: OperationContext): void => {
		runs.push({ operation: c.operation, input, invocation: c.invocation, attempt: c.attempt, correlationId: c.delivery.correlationId, origin: c.delivery.source.originNodeId });
	};
	const who = (c: OperationContext): JsonValue => ({ host: nodeId, invocation: c.invocation, attempt: c.attempt });
	const any = { $schema: DIALECT };
	const handlers: { [name: string]: [JsonInput, OperationHandler] } = {
		echo: [any, (input) => ({ outcome: "answered", answer: input })],
		which: [any, (_input, c) => ({ outcome: "answered", answer: who(c) })],
		hold: [any, async (input, c) => {
			const held = latch();
			holds.push(held);
			await held.wait;
			return { outcome: "answered", answer: { ...(who(c) as { [n: string]: JsonValue }), input } };
		}],
		silent: [any, (_input, c) => new Promise((_resolve, reject) => c.signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true }))],
		deeper: [any, (input) => ({ outcome: "answered", answer: [input] })],
		sized: [any, (input) => ({ outcome: "answered", answer: "x".repeat((input as { bytes: number }).bytes) })],
		refuses: [any, (input) => ({ outcome: "refused", refusal: input as unknown as RefusalRecord })],
		throws: [any, () => { throw new Error("the fixture operation failed"); }],
		strict: [{ $schema: DIALECT, type: "object", required: ["n"], properties: { n: { type: "integer" } }, additionalProperties: false }, (input) => ({ outcome: "answered", answer: input })],
	};
	for (const name of FIXTURE_OPERATIONS) {
		const [input, handler] = handlers[name] as [JsonInput, OperationHandler];
		const outcome = await opening.host.declare({ name, input, answers: "whole" }, (value, c) => {
			record(value, c);
			return handler(value, c);
		});
		check(outcome.declared, `the fixture operation ${name} is declared`);
	}
	return { nodeId, host: opening.host, runs, holds };
}

/** Opens a session, its fixture hosts, and waits until every fixture operation can be called on both. */
export async function openCase(harness: CallerSuiteHarness, options: CallerSuiteOpenOptions = {}): Promise<CaseContext> {
	const session = await harness.open(options);
	try {
		const [ha, hb] = session.hosts;
		const a = await openFixtureHost(ha.nodeId, ha.node);
		const b = await openFixtureHost(hb.nodeId, hb.node);
		for (const host of [a, b]) {
			for (const name of [...FIXTURE_OPERATIONS, "describe"]) await session.hooks.ready(host.nodeId, `${SERVICE}/${name}`);
		}
		const call = (request: Partial<CallRequest> & { readonly operation: string }): Promise<CallEnding> =>
			session.caller.invoke({ host: a.nodeId, service: SERVICE, input: {}, bound: 1000, ...request });
		const ended = async (request: Partial<CallRequest> & { readonly operation: string }): Promise<CallEnding> => {
			const watched = watch(call(request));
			await until(watched.settled, `the ending of a call to ${request.operation}`);
			return watched.promise;
		};
		return { session, hooks: session.hooks, harness, a, b, call, ended };
	} catch (error) {
		await session.close();
		throw error;
	}
}

/** Runs a case in a fresh session, closing it whatever happens. */
export async function inCase(harness: CallerSuiteHarness, options: CallerSuiteOpenOptions, body: (c: CaseContext) => Promise<void>): Promise<void> {
	const c = await openCase(harness, options);
	try {
		await body(c);
	} finally {
		for (const host of [c.a, c.b]) for (const held of host.holds) held.release();
		await c.session.close();
	}
}

/**
 * Waits for a watched call to end while running what falls due on AGP's clock without moving it, so the
 * host nodes send the delivery reports they hold for no time (a debounce of 0).
 */
export async function untilEndedPumping(c: CaseContext, call: Watched<CallEnding>, what: string): Promise<CallEnding> {
	for (let i = 0; i < 4000 && !call.settled(); i++) {
		c.hooks.advanceAgpClock(0);
		await turn();
	}
	check(call.settled(), `${what}: the call ends`);
	return call.value() as CallEnding;
}

/** The caller's count of discarded messages, when the caller under test offers one. */
export function discardedCount(c: CaseContext): number | undefined {
	const counter = (c.session.caller as { discarded?: () => number }).discarded;
	return typeof counter === "function" ? counter.call(c.session.caller) : undefined;
}

/** Checks an ending decided at the bound: unknown, `bound-passed`, no AGP code, the delivery report given. */
export function checkAtBound(ending: CallEnding | undefined, harness: CallerSuiteHarness, deliveryReport: "delivered" | "unknown" | null, what: string): void {
	check(ending !== undefined, `${what}: an ending`);
	same(ending.ending, "unknown", `${what}: the ending`);
	if (ending.ending !== "unknown") return;
	if (harness.hopAtBound === true && ending.reason === "hop-stalled" as never) {
		same(ending.agpCode, null, `${what}: no AGP code across the hop`);
		same(ending.deliveryReport, null, `${what}: no delivery report across the hop`);
		return;
	}
	same(ending.reason, "bound-passed", `${what}: the reason`);
	same(ending.agpCode, null, `${what}: no AGP code`);
	same(ending.deliveryReport, deliveryReport, `${what}: the last delivery report`);
}

/** Checks a not-delivered ending: AGP's code, no refusal, and whether earlier attempts are uncertain. */
export function checkNotDelivered(ending: CallEnding | undefined, codes: readonly string[], uncertain: boolean, what: string): void {
	check(ending !== undefined, `${what}: an ending`);
	same(ending.ending, "not-delivered", `${what}: the ending`);
	if (ending.ending !== "not-delivered") return;
	check(codes.includes(ending.agpCode), `${what}: AGP's code is one of ${codes.join(", ")}, not ${ending.agpCode}`);
	check(!Object.hasOwn(ending, "refusal"), `${what}: no refusal record`);
	same(ending.earlierAttemptsUncertain, uncertain, `${what}: earlierAttemptsUncertain`);
}
