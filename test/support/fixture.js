// fixture - three AGP nodes over AGP's production in-process carrier, @agp/transport-loopback: a caller's
// node dialling two host nodes that listen (zorg's Delta 1, verification targets; E6, E8). Every node runs
// on one AGP injected clock (ManualClock), and the call's bound on a separate manual clock. The fixture
// offers the hooks of operation-call's caller suite: both clocks, a fault of the caller's own clock port, an
// executor barrier on any node, the loss of the channel between the caller's node and a host, and the
// observations a case waits on, the rejections and exceptions left unhandled among them.
import { ManualClock } from "@agp/core";
import { createNode } from "@agp/node";
import { createLoopbackFabric } from "@agp/transport-loopback";
import { createCaller, systemCallClock } from "@apnex/operation-call";
import { createManualCallClock } from "./manual-call-clock.js";

const REPLY = "operation-call/replies";
let fabrics = 0;

/** A turn of the event loop. */
export const turn = () => new Promise((resolve) => setImmediate(resolve));

/** Waits until a condition holds, failing after a bounded real time rather than hanging. */
export async function until(condition, what, ms = 5000) {
	const end = performance.now() + ms;
	while (performance.now() < end) {
		if (condition()) return;
		await turn();
	}
	throw new Error(`waited for ${what}, which never happened`);
}

/** Rejects when a promise has not settled within a real time, so a failing case fails rather than hangs. */
export function within(promise, what = "the ending", ms = 15_000) {
	let timer;
	const late = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not come within ${ms} ms`)), ms); });
	return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * The clock port of the caller under test over `clock`, with the caller suite's fault hook (zorg's EM12): once
 * armed, it throws at its next reading, or at its next cancellation of a timer, which it then leaves to run,
 * as a port that failed to cancel it would; it records each throw, and counts the timers it holds that have
 * neither run nor been cancelled.
 */
export function faultableCallClock(clock) {
	let armed;
	const faults = [];
	const live = new Set();
	return {
		faults,
		arm(at) {
			if (at !== "read" && at !== "cancel") throw new RangeError(`a clock port fails at a reading or a cancellation, not ${at}`);
			armed = at;
		},
		outstanding: () => live.size,
		now() {
			if (armed === "read") {
				armed = undefined;
				faults.push("read");
				throw new Error("the caller suite's fault hook: the clock port could not be read");
			}
			return clock.now();
		},
		schedule(delayMs, callback) {
			const entry = {};
			live.add(entry);
			let timer;
			try {
				timer = clock.schedule(delayMs, () => { live.delete(entry); callback(); });
			} catch (error) {
				live.delete(entry);
				throw error;
			}
			return {
				cancel() {
					if (armed === "cancel") {
						armed = undefined;
						faults.push("cancel");
						throw new Error("the caller suite's fault hook: the clock port could not cancel a timer");
					}
					live.delete(entry);
					timer.cancel();
				},
			};
		},
	};
}

/**
 * Builds the topology: `caller` dials `host-a` and `host-b`. Options: holdDeliveryReports, a host
 * disposition debounce of 60 s with no count bound; identities, the caller's identity source; callerOptions,
 * passed to createCaller; makeCaller false, to build no caller; realCallClock, to bound calls on the
 * default system call clock instead of the manual one, whose hooks then refuse to move it. The caller's
 * invoke fails a call with no ending within 15 s of real time, unless boundedInvoke is false, as the caller
 * suite's harness needs. The caller is given the fault hook's clock port over the call clock, unless
 * faultCaller is false, as for a caller under test in front of it, which takes `faultableClock` itself.
 */
export async function openTopology(options = {}) {
	const fabricId = `operation-call-${++fabrics}`;
	const fabric = createLoopbackFabric({ fabricId, limits: {
		maxTransports: 8, maxListeners: 8, maxPendingAcquisitions: 8, maxActiveChannels: 8, maxPacketBytes: 16_777_216,
		maxBufferedPacketsPerChannel: 1_024, maxBufferedBytesPerChannel: 67_108_864, maxQueuedPacketsTotal: 65_536,
		maxQueuedBytesTotal: 268_435_456, maxPendingSendBytesTotal: 17_179_869_184,
	} });
	const agpClock = new ManualClock();
	const manualClock = createManualCallClock();
	const callClock = options.realCallClock ? systemCallClock : manualClock;
	const faultableClock = faultableCallClock(callClock);
	// Each rejection left unhandled and each exception left uncaught while the topology is open.
	const unhandled = [];
	const onUnhandled = (error) => { unhandled.push(error); };
	process.on("unhandledRejection", onUnhandled);
	process.on("uncaughtException", onUnhandled);
	const manual = (what) => {
		if (options.realCallClock) throw new Error(`${what}: this session bounds calls on the system call clock, which no hook moves`);
		return manualClock;
	};
	const channels = new Map();
	const port = (name, listen, targets) => {
		const scoped = fabric.createTransport({ transportName: name, capabilities: { listen, connect: targets.length > 0 } }).createPort({
			listeners: new Map(listen ? [["listen", { fabricId, address: name }]] : []),
			targets: new Map(targets.map((t) => [t, { fabricId, address: t }])),
		});
		return {
			resolveListener: (reference) => scoped.resolveListener(reference),
			resolveTarget(reference) {
				const target = scoped.resolveTarget(reference);
				if (target === undefined) return undefined;
				return { async connect(o, signal) { const channel = await target.connect(o, signal); channels.set(reference, channel); return channel; } };
			},
		};
	};
	const capacity = { maxSessions: 4, maxPendingHandshakes: 4 };
	const timers = { holdTimeMs: 0 };
	const hostDisposition = options.holdDeliveryReports ? { debounceMs: 60_000, maximumOutcomes: 1_000_000 } : { debounceMs: 0 };
	const hostNode = (id) => createNode({ nodeId: id, listen: { transportRef: "listen" }, capacity, timers, disposition: hostDisposition }, { clock: agpClock, transport: port(id, true, []) });
	const hosts = [{ nodeId: "host-a", node: hostNode("host-a") }, { nodeId: "host-b", node: hostNode("host-b") }];
	const reconnect = { initialDelayMs: 10, maximumDelayMs: 10 };
	const callerNode = createNode({ nodeId: "caller", capacity, timers, disposition: { debounceMs: 0 }, peers: hosts.map((h) => ({
		adjacencyId: h.nodeId, expectedNodeId: h.nodeId, transportRef: h.nodeId, reconnect,
	})) }, { clock: agpClock, transport: port("caller", false, hosts.map((h) => h.nodeId)) });
	const nodes = new Map([["caller", callerNode], ...hosts.map((h) => [h.nodeId, h.node])]);

	// Every report AGP gives the caller's node for a request, in arrival order.
	const reports = [];
	const stream = callerNode.dispositions({ source: REPLY });
	(async () => { for await (const d of stream) for (const o of d.outcomes) reports.push(o.kind); })();

	// The caller's node as the caller sees it: every send it is asked for is counted; one can be made to fail
	// with no AGP code, unsent; and a send runs an action, when one waits, once admitted.
	const afterAdmission = [];
	let requests = 0;
	let failNext = false;
	const sendingNode = {
		nodeId: callerNode.nodeId,
		operations: callerNode.operations,
		start: (...a) => callerNode.start(...a),
		stop: (...a) => callerNode.stop(...a),
		expose: (...a) => callerNode.expose(...a),
		disposition: (...a) => callerNode.disposition(...a),
		settled: (...a) => callerNode.settled(...a),
		dispositions: (...a) => callerNode.dispositions(...a),
		async send(...args) {
			requests++;
			if (failNext) {
				failNext = false;
				throw new Error("a send failed with no AGP code, by the fixture's hook");
			}
			const receipt = await callerNode.send(...args);
			afterAdmission.shift()?.();
			return receipt;
		},
	};

	// Executor holds not yet released, released when the topology closes so stopping never waits on one.
	const holds = new Set();
	const exportAcked = (node, endpoint, remote) => node.operations.routeExports().items.some((r) => r.endpoint === endpoint && r.remoteNodeId === remote && r.state === "acked");
	const routeVisible = (hostId, endpoint) => callerNode.operations.routes().candidates.some((r) => r.endpoint === endpoint && r.originNodeId === hostId);
	const hooks = {
		advanceCallClock: (ms) => manual("advanceCallClock").advance(ms),
		moveCallClock: (ms) => manual("moveCallClock").move(ms),
		advanceAgpClock: (ms) => agpClock.advanceBy(ms),
		holdExecutor(nodeId) {
			const node = nodes.get(nodeId);
			const blocker = Promise.withResolvers();
			holds.add(blocker);
			const blocked = node.executor.run(() => blocker.promise);
			return async () => { blocker.resolve(); await blocked; await node.executor.quiesce(); };
		},
		loseChannel(hostId) { channels.get(hostId).abort({ kind: "abort" }); },
		async ready(hostId, endpoint) {
			const host = nodes.get(hostId);
			const isReady = () => routeVisible(hostId, endpoint) && exportAcked(callerNode, REPLY, hostId) && exportAcked(host, endpoint, "caller");
			const end = performance.now() + 5000;
			while (!isReady()) {
				if (performance.now() > end) throw new Error(`${endpoint} on ${hostId} never became ready`);
				// A lost channel is redialled after 10 ms of AGP's clock.
				if (!callerNode.operations.connections().items.some((c) => c.remoteNodeId === hostId && c.state === "Established")) agpClock.advanceBy(10);
				await turn();
			}
		},
		routeVisible,
		reports: () => [...reports],
		afterNextAdmission: (action) => { afterAdmission.push(action); },
		requests: () => requests,
		failNextSend: () => { failNext = true; },
		failCallClock: (at) => faultableClock.arm(at),
		callClockFaults: () => [...faultableClock.faults],
		// operation-call's caller holds no connection open and does not prepare: what it keeps is its timers.
		outstanding: () => faultableClock.outstanding(),
		unhandled: () => [...unhandled],
	};

	for (const h of hosts) await h.node.start();
	await callerNode.start();
	const built = options.makeCaller === false ? undefined
		: await createCaller({ node: sendingNode, clock: options.faultCaller === false ? callClock : faultableClock, ...(options.identities ? { identities: options.identities } : {}), ...options.callerOptions });
	const caller = built === undefined || options.boundedInvoke === false ? built
		: { ...built, invoke: (call) => within(built.invoke(call), `the ending of a call to ${call?.operation}`) };
	await until(() => hosts.every((h) => callerNode.operations.connections().items.some((c) => c.remoteNodeId === h.nodeId && c.state === "Established")), "both sessions established");

	return {
		fabric, agpClock, callClock, faultableClock, callerNode, sendingNode, hosts, caller, hooks, channels,
		async close() {
			process.off("unhandledRejection", onUnhandled);
			process.off("uncaughtException", onUnhandled);
			for (const blocker of holds) blocker.resolve();
			stream.close();
			await Promise.allSettled([callerNode.stop(), ...hosts.map((h) => h.node.stop())]);
			await fabric.close(AbortSignal.timeout(5000));
		},
	};
}

/** operation-call's own caller under its caller suite (operation-proxy's PX10; zorg's E6): a direct caller, no hop. */
export const directHarness = {
	hopAllowanceMs: 0,
	async open(options = {}) {
		const t = await openTopology({ ...options, boundedInvoke: false });
		return { caller: t.caller, callerNodeId: "caller", hosts: t.hosts, hooks: t.hooks, close: () => t.close() };
	},
};
