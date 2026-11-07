// controlled-host - an operation-call host over an object with the AgpNode surface a host uses, whose every
// send the test decides - admitted at once, held until the test admits or refuses it, or refused with a code -
// and whose endpoints' handlers the test calls itself, with any message from any node (zorg's target, EM11).
// It shows the host's rules for parts, alive and cancel that AGP's production carrier cannot place exactly:
// a cancel while the evidence port is held, a part's admission held while another waits, a send refused.
// The host keeps time on a manual call clock; the production carrier carries the caller suite's cases.
import { createOperationHost } from "@apnex/operation-call";
import { createManualCallClock } from "./manual-call-clock.js";

export const ANY = { $schema: "urn:apnex:shape-check:dialect:1" };
export const REPLIES = "operation-call/replies";

let counter = 0;

/** A new attempt identity of a new invocation, as EM11 writes them. */
export function newAttempt() {
	const n = (++counter).toString(16).padStart(16, "0");
	const invocation = `1791540000000-${n}`;
	return { invocation, attempt: `${invocation}.${n.slice(8)}` };
}

/**
 * Opens a host under `service` over a controlled node. `decide(send)` gives each send's fate as it is made:
 * "admit" (the default), "hold", or `{ reject: code }` (code null for none). A held send is admitted or
 * refused later through its `admit()` or `refuse(code)`.
 */
export async function controlledHost({ service = "svc", clock = createManualCallClock(0), evidence, mode, minimumProtection } = {}) {
	const sends = [];
	const handlers = new Map();
	const fate = { decide: () => "admit" };
	const node = {
		async expose(endpoint, handler) {
			handlers.set(endpoint, handler);
			return { close: async () => { handlers.delete(endpoint); } };
		},
		sendDirectPeer(source, destination, payload, options) {
			const outcome = Promise.withResolvers();
			const entry = {
				source, destination, payload, options, state: "held",
				admit() { if (entry.state === "held") { entry.state = "admitted"; outcome.resolve({ messageId: `m${sends.indexOf(entry)}` }); } },
				refuse(code) { if (entry.state === "held") { entry.state = "refused"; outcome.reject(code === null || code === undefined ? new Error("refused, no code") : Object.assign(new Error(code), { code })); } },
			};
			sends.push(entry);
			const decided = fate.decide(entry);
			if (decided === "admit") entry.admit();
			else if (decided !== "hold") entry.refuse(decided.reject);
			return outcome.promise;
		},
	};
	const opening = await createOperationHost(node, {
		service,
		clock,
		...(evidence === undefined ? {} : { evidence }),
		...(mode === undefined ? {} : { mode }),
		...(minimumProtection === undefined ? {} : { minimumProtection }),
	});
	if (!opening.opened) throw new Error("the controlled host did not open");
	const nodeSignal = new AbortController();
	const defaultAssociation = mode === "authenticated"
		? { mode: "authenticated", issuer: "zorg-credential-issuer/v1", principal: "alice", instanceBinding: "inst-1" }
		: { mode: "unauthenticated" };
	return {
		host: opening.host, clock, sends, fate, nodeSignal,
		/** Declares an operation, whole or in parts. */
		declare: (name, handler, answers = "whole") => opening.host.declare({ name, input: ANY, answers }, handler),
		/**
		 * Delivers a payload to `<service>/<operation>` as AGP would, from `origin`'s reply endpoint under `label`;
		 * resolves once the host's handler has finished with it - for a request, once its end was sent.
		 */
		deliver(operation, payload, opts = {}) {
			const { label = payload?.attempt, origin = "caller" } = opts;
			const hasDirectPeer = Object.hasOwn(opts, "directPeer");
			const directPeer = hasDirectPeer ? opts.directPeer : { originNodeId: origin, authorizationAssociation: defaultAssociation };
			const handler = handlers.get(`${service}/${operation}`);
			if (handler === undefined) throw new Error(`no endpoint ${service}/${operation}`);
			return handler(payload, {
				delivery: {
					correlationId: label,
					source: { endpoint: REPLIES, originNodeId: origin },
					...(directPeer === undefined ? {} : { directPeer }),
				},
				signal: nodeSignal.signal,
			});
		},
		/** The sends of one type for an attempt, in order. */
		sent: (type, attempt) => sends.filter((s) => s.payload.type === type && (attempt === undefined || s.payload.attempt === attempt)),
	};
}

/** A request for an operation from an address, with `aliveWithinMs` when given. */
export function requestOf(address, operation, input = {}, aliveWithinMs) {
	return { operationCall: 1, type: "request", invocation: address.invocation, attempt: address.attempt, operation, input, ...(aliveWithinMs === undefined ? {} : { aliveWithinMs }) };
}

/** A control message - "cancel" or "alive" - for an operation from an address, with `changes` over its fields. */
export function controlOf(type, address, operation, changes = {}) {
	const message = { operationCall: 1, type, invocation: address.invocation, attempt: address.attempt, operation, ...changes };
	for (const [name, value] of Object.entries(changes)) if (value === undefined) delete message[name];
	return message;
}

/** Turns of the event loop, so every reaction the last step started has run. */
export async function turns(n = 10) {
	for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
}
