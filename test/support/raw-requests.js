// raw-requests - send hand-written payloads from the caller's node to a host, and record every message the
// host sends back to the reply endpoint, for cases about what a host does with requests no operation-call
// caller would write (zorg's target, EM11).
import { openTopology, until } from "./fixture.js";

export const ANY = { $schema: "urn:apnex:shape-check:dialect:1" };
export const INVOCATION = "1791540000000-0123456789abcdef";
export const ATTEMPT = `${INVOCATION}.89abcdef`;

/** A request as an operation-call caller writes it, with any field replaced or removed (undefined). */
export function request(operation, input = {}, changes = {}) {
	const message = { operationCall: 1, type: "request", invocation: INVOCATION, attempt: ATTEMPT, operation, input, ...changes };
	for (const [name, value] of Object.entries(changes)) if (value === undefined) delete message[name];
	return message;
}

/**
 * A topology with no caller: host-a opens an operation-call host under `service` with `hostOptions`, and
 * `declare(host)` declares its operations; the caller's node records the reply endpoint's messages.
 */
export async function openRaw(t, { service = "svc", hostOptions = {}, declare, endpoints = [] } = {}) {
	const topology = await openTopology({ makeCaller: false });
	t.after(() => topology.close());
	const { createOperationHost } = await import("@apnex/operation-call");
	const opening = await createOperationHost(topology.hosts[0].node, { service, ...hostOptions });
	if (!opening.opened) throw new Error(`the host did not open: ${JSON.stringify(opening.refusal)}`);
	if (declare) await declare(opening.host);
	const replies = [];
	await topology.callerNode.expose("operation-call/replies", async (payload, context) => { replies.push({ payload, delivery: context.delivery }); });
	for (const endpoint of [`${service}/describe`, ...endpoints]) await topology.hooks.ready("host-a", endpoint);
	/** Sends a payload to an endpoint on host-a under a correlation label, or none when the label is null. */
	const send = (endpoint, payload, label = ATTEMPT) => topology.callerNode.send("operation-call/replies", endpoint, payload, {
		...(label === null ? {} : { correlationId: label }),
		destinationSelector: { originNodeId: "host-a", mode: "pinned" },
	});
	/** Waits for the reply count to reach n. */
	const repliesReach = (n) => until(() => replies.length >= n, `${n} replies`);
	return { topology, host: opening.host, replies, send, repliesReach };
}
