/**
 * What operation-call's caller contract suite runs against (operation-proxy's PX10; zorg's E6, E17).
 *
 * A harness opens a fresh session for each case: the caller under test - operation-call's own caller, or
 * another implementation of the same caller interface, such as operation-proxy's client half - the AGP node
 * that sends the caller's requests, two host nodes on which the suite serves the same fixture operations,
 * and the fixture's hooks: the call bound's clock, a fault of the caller under test's own clock port, AGP's
 * injected clock, an executor barrier, the channel-loss hook, and the observations a case waits on. Every node runs over AGP's production in-process
 * carrier, `@agp/transport-loopback`. Nothing here is particular to one runtime (zorg's D31).
 */
import type { AgpNode } from "@agp/node";
import type { OperationCaller } from "../call-types.js";

/** One host node: the suite opens operation-call hosts on it and declares its fixture operations there. */
export interface SuiteHost {
	/** The node's AGP identifier, which calls name as the host they mean. */
	readonly nodeId: string;
	/** The host's AGP node, adjacent to the caller's node, created and not yet stopped. */
	readonly node: AgpNode;
}

/** The fixture's hooks. */
export interface CallerSuiteHooks {
	/** Advances the clock the call's bound runs on, running everything due, what fell due earlier included. */
	advanceCallClock(ms: number): void;
	/**
	 * Moves the reading of the clock the call's bound runs on, running nothing that falls due, as a runtime
	 * does whose timer callbacks are delayed behind other work; the next `advanceCallClock`, of 0 or more,
	 * runs what fell due. An event the caller observes in between happened after the time it reads (EM12).
	 */
	moveCallClock(ms: number): void;
	/** Advances AGP's injected clock on every node, running everything due; 0 runs what is due now. */
	advanceAgpClock(ms: number): void;
	/**
	 * Holds the serialized executor of the named node - the caller's node or a host's - so a send or a
	 * delivery queues behind it; returns the release, which resolves once the executor has drained.
	 */
	holdExecutor(nodeId: string): () => Promise<void>;
	/** Aborts the carrier channel between the caller's node and the named host's node. */
	loseChannel(hostNodeId: string): void;
	/**
	 * Resolves once a request from the caller to `endpoint` on the named host can be sent and answered: the
	 * caller's node holds a route to it from that host, and each side's export of its own endpoint to the
	 * other is acknowledged. It redials a lost channel, advancing AGP's clock as the redial needs.
	 */
	ready(hostNodeId: string, endpoint: string): Promise<void>;
	/** True while the caller's node holds a route to `endpoint` from the named host. */
	routeVisible(hostNodeId: string, endpoint: string): boolean;
	/** Each delivery outcome AGP has reported to the caller's node for a request it sent, in arrival order. */
	reports(): readonly ("delivered" | "unknown" | "failed")[];
	/** Runs `action` once the next request the caller's node sends is admitted, before its receipt is returned. */
	afterNextAdmission(action: () => void): void;
	/** How many sends the caller's node has been asked to make, whether AGP admitted or rejected them. */
	requests(): number;
	/** Makes the next send the caller's node is asked for reject with an error carrying no AGP code, unsent. */
	failNextSend(): void;
	/**
	 * Makes the clock port of the caller under test throw once: at its next reading (`read`), or at its next
	 * cancellation of a timer (`cancel`), which then leaves that timer to run, as a port that failed to cancel
	 * it would. The port is the caller under test's own - operation-call's caller's in a direct harness, the
	 * client half's across a hop - never that of the call layer beneath a hop (zorg's EM12; operation-proxy's
	 * PX10). A clock port that throws is a fault of the port, and the event the caller observed then decides.
	 */
	failCallClock(at: "read" | "cancel"): void;
	/** Each throw `failCallClock` made the clock port of the caller under test give, in order. */
	callClockFaults(): readonly ("read" | "cancel")[];
	/**
	 * How many things the caller under test still keeps that could hold its process or wait, as its harness
	 * observes them: timers on its clock port neither run nor cancelled, connections it holds its process open
	 * by, and connections it is still making while it prepares.
	 */
	outstanding(): number;
	/** Each rejection left unhandled, and each exception left uncaught, in the session's process since it opened. */
	unhandled(): readonly unknown[];
	/**
	 * Present only for a caller that prepares before it sends, such as operation-proxy's client half (its PX5):
	 * makes its next preparing be refused by the far side, and gives the `proxyCode` the not-delivered ending
	 * then names.
	 */
	refuseNextPreparing?(): string;
}

/** One case's session. */
export interface CallerSuiteSession {
	/** The caller under test. */
	readonly caller: OperationCaller;
	/** The AGP node identifier of the node that sends the caller's requests. */
	readonly callerNodeId: string;
	/** Two host nodes, which the suite has advertise the same operation names. */
	readonly hosts: readonly [SuiteHost, SuiteHost];
	readonly hooks: CallerSuiteHooks;
	/** Stops every node and the carrier. */
	close(): Promise<void>;
}

/** How a case wants its session. */
export interface CallerSuiteOpenOptions {
	/**
	 * When true, the host nodes hold their delivery reports - a debounce of 60 seconds on AGP's clock and no
	 * count bound - so a lost channel is the only thing that can settle a request; otherwise they report at
	 * once, when AGP's clock is advanced by 0.
	 */
	readonly holdDeliveryReports?: boolean;
	/**
	 * When true, the call's bound runs on the system's own clock - operation-call's default clock port, or
	 * whatever clock the caller under test reads in production - for a case about real time; the hooks that
	 * move the call bound's clock are then not used.
	 */
	readonly realCallClock?: boolean;
}

/** What a consumer of the suite supplies. */
export interface CallerSuiteHarness {
	open(options?: CallerSuiteOpenOptions): Promise<CallerSuiteSession>;
	/**
	 * The hop allowance, a whole number of milliseconds: 0 for a direct caller, such as operation-call's own;
	 * for a caller across a hop, such as operation-proxy's client half, the allowance by which the call it
	 * makes on the far side of the hop is bound to end before the caller's own bound (zorg's D45;
	 * operation-proxy's PX5, PX9). For a call of a given bound the allowance is this, or half the bound if
	 * that is less, rounded down. A case whose call ends at its bound advances the call bound's clock to the
	 * allowance's edge, lets the hop carry the ending, and accepts `unknown` with `bound-passed` and the call
	 * layer's delivery report up to the allowance early; it never accepts `hop-stalled`, which only a hop
	 * holding the ending past the allowance gives (operation-proxy's PX6, PX10). With 0, each such case runs
	 * exactly as for a direct caller.
	 */
	readonly hopAllowanceMs: number;
}

/** How the suite registers a case with the consumer's test runner, as node:test's `test` does. */
export type SuiteRegister = (name: string, run: () => Promise<void>) => unknown;

/** One case of the suite. */
export interface SuiteCase {
	readonly name: string;
	run(harness: CallerSuiteHarness): Promise<void>;
}
