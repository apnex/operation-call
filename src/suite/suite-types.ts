/**
 * What operation-call's caller contract suite runs against (operation-proxy's PX10; zorg's E6, E17).
 *
 * A harness opens a fresh session for each case: the caller under test - operation-call's own caller, or
 * another implementation of the same caller interface, such as operation-proxy's client half - the AGP node
 * that sends the caller's requests, two host nodes on which the suite serves the same fixture operations,
 * and the fixture's hooks: the call bound's clock, AGP's injected clock, an executor barrier, the
 * channel-loss hook, and the observations a case waits on. Every node runs over AGP's production in-process
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
	/** Advances the clock the call's bound runs on, running everything due. */
	advanceCallClock(ms: number): void;
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
}

/** What a consumer of the suite supplies. */
export interface CallerSuiteHarness {
	open(options?: CallerSuiteOpenOptions): Promise<CallerSuiteSession>;
	/**
	 * True for a caller across a hop, such as operation-proxy's client half: an ending the suite expects at
	 * the bound may instead be `unknown` with reason `hop-stalled`, `agpCode` null and `deliveryReport` null
	 * (operation-proxy's PX6, PX10).
	 */
	readonly hopAtBound?: boolean;
}

/** How the suite registers a case with the consumer's test runner, as node:test's `test` does. */
export type SuiteRegister = (name: string, run: () => Promise<void>) => unknown;

/** One case of the suite. */
export interface SuiteCase {
	readonly name: string;
	run(harness: CallerSuiteHarness): Promise<void>;
}
