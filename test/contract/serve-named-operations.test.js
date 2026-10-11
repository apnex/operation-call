// serve-named-operations - a host exposes declared operations by name, and every invocation gets exactly
// one ending even when the operation fails (zorg's target, EM10, EM11; zorg's D7; zorg's E8).
//
// Cases: each declared operation at its own AGP endpoint, observed in AGP's route view, with two hosts
// advertising the same names; an undeclared operation refused by AGP before any handler or evidence runs;
// an operation that throws, rejects, or gives no valid result ending failed with operation-failed; an answer
// that cannot cross AGP whole - not JSON, an unsafe integer, 31 levels - replaced by answer-not-sendable
// with no AGP code; and an answer whose send AGP refuses replaced once by answer-not-sendable with AGP's
// code, nothing sent when that fails too. Two hosts pinned apart are the suite's advertiser-instance-select.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createOperationHost } from "@apnex/operation-call";
import { openTopology, turn } from "../support/fixture.js";
import { ANY, ATTEMPT, INVOCATION, openRaw, request } from "../support/raw-requests.js";

const end = (rest, attempt = ATTEMPT) => ({ operationCall: 1, type: "end", invocation: INVOCATION, attempt, operation: "op", ...rest });

test("each declared operation is served at its own AGP endpoint, seen in AGP's route view from both hosts advertising the same names", async (t) => {
	const topology = await openTopology();
	t.after(() => topology.close());
	for (const { node } of topology.hosts) {
		const { host } = await createOperationHost(node, { service: "svc" });
		for (const name of ["read", "write"]) await host.declare({ name, input: ANY, answers: "whole" }, () => ({ outcome: "answered", answer: node.nodeId }));
		assert.deepEqual(node.operations.endpoints().items.map((e) => e.endpoint).sort(), ["svc/describe", "svc/read", "svc/write"]);
	}
	for (const h of ["host-a", "host-b"]) for (const e of ["svc/describe", "svc/read", "svc/write"]) await topology.hooks.ready(h, e);
	const seen = topology.callerNode.operations.routes().candidates.filter((r) => r.endpoint.startsWith("svc/")).map((r) => `${r.endpoint}@${r.originNodeId}`).sort();
	assert.deepEqual(seen, ["svc/describe@host-a", "svc/describe@host-b", "svc/read@host-a", "svc/read@host-b", "svc/write@host-a", "svc/write@host-b"]);
	for (const h of ["host-a", "host-b"]) {
		const ending = await topology.caller.invoke({ host: h, service: "svc", operation: "write", input: {}, bound: 1000 });
		assert.deepEqual([ending.ending, ending.answer], ["answered", h]);
	}
});

test("an operation the host does not declare has no endpoint, so AGP refuses the call before any handler runs or any evidence is asked", async (t) => {
	const topology = await openTopology();
	t.after(() => topology.close());
	const events = [];
	const { host } = await createOperationHost(topology.hosts[0].node, { service: "svc", evidence: () => { events.push("evidence"); return null; } });
	await host.declare({ name: "op", input: ANY, answers: "whole" }, () => { events.push("handler"); return { outcome: "answered", answer: 1 }; });
	await topology.hooks.ready("host-a", "svc/op");
	const ending = await topology.caller.invoke({ host: "host-a", service: "svc", operation: "other", input: {}, bound: 1000 });
	assert.deepEqual([ending.ending, ending.agpCode], ["not-delivered", "NO_ROUTE"]);
	assert.deepEqual(events, []);
});

test("every request gets exactly one end message when the operation throws, rejects, gives no valid result, or answers what cannot cross AGP", async (t) => {
	let deep = 0;
	for (let i = 0; i < 30; i++) deep = [deep];
	const behaviours = [
		[() => { throw new Error("sync"); }, { outcome: "failed", reason: "operation-failed", agpCode: null }],
		[async () => { throw new Error("async"); }, { outcome: "failed", reason: "operation-failed", agpCode: null }],
		[() => undefined, { outcome: "failed", reason: "operation-failed", agpCode: null }],
		[() => ({ outcome: "answered" }), { outcome: "failed", reason: "operation-failed", agpCode: null }],
		[() => ({ outcome: "answered", answer: 1, extra: 2 }), { outcome: "failed", reason: "operation-failed", agpCode: null }],
		[() => ({ outcome: "done", answer: 1 }), { outcome: "failed", reason: "operation-failed", agpCode: null }],
		[() => ({ outcome: "answered", answer: undefined }), { outcome: "failed", reason: "answer-not-sendable", agpCode: null }],
		[() => ({ outcome: "answered", answer: { n: Number.NaN } }), { outcome: "failed", reason: "answer-not-sendable", agpCode: null }],
		[() => ({ outcome: "answered", answer: { n: 9007199254740992 } }), { outcome: "failed", reason: "answer-not-sendable", agpCode: null }],
		[() => ({ outcome: "answered", answer: deep }), { outcome: "failed", reason: "answer-not-sendable", agpCode: null }],
		[() => ({ outcome: "answered", answer: 9007199254740991 }), { outcome: "answered", answer: 9007199254740991 }],
	];
	const raw = await openRaw(t, { declare: (host) => host.declare({ name: "op", input: ANY, answers: "whole" }, (input, context) => behaviours[input][0](input, context)), endpoints: ["svc/op"] });
	for (let i = 0; i < behaviours.length; i++) {
		const attempt = `${INVOCATION}.000000${String(i).padStart(2, "0")}`;
		await raw.send("svc/op", request("op", i, { attempt }), attempt);
	}
	await raw.repliesReach(behaviours.length);
	for (let i = 0; i < 50; i++) await turn();
	assert.equal(raw.replies.length, behaviours.length, "exactly one end message for each request");
	for (const { payload } of raw.replies) {
		const i = Number(payload.attempt.slice(-2));
		assert.deepEqual(payload, end(behaviours[i][1], payload.attempt), `behaviour ${i}`);
	}
});

/** An AGP node with the surface a host uses, whose sends AGP refuses with the codes given, in turn. */
function refusingNode(codes) {
	const exposed = new Map();
	const sent = [];
	return {
		exposed, sent, nodeId: "fake-host",
		async expose(endpoint, handler) { exposed.set(endpoint, handler); return { close: async () => {} }; },
		async send(source, destination, payload, options) {
			sent.push({ source, destination, payload, options });
			const code = codes.shift();
			if (code !== undefined) throw Object.assign(new Error("refused"), { code });
			return { messageId: `m${sent.length}` };
		},
	};
}

const delivery = { messageId: "m", correlationId: ATTEMPT, source: { endpoint: "operation-call/replies", originNodeId: "caller-node" }, destination: "svc/op", receivedAt: "2026-01-01T00:00:00.000Z", operationsRevision: "1" };

test("an answer whose send AGP refuses is replaced, once, by answer-not-sendable with AGP's code; when that is refused too, nothing more is sent", async () => {
	for (const [codes, expected] of [
		[[], [{ outcome: "answered", answer: "a" }]],
		[["QUEUE_FULL"], [{ outcome: "answered", answer: "a" }, { outcome: "failed", reason: "answer-not-sendable", agpCode: "QUEUE_FULL" }]],
		[["NO_ROUTE", "NO_ROUTE"], [{ outcome: "answered", answer: "a" }, { outcome: "failed", reason: "answer-not-sendable", agpCode: "NO_ROUTE" }]],
	]) {
		const node = refusingNode([...codes]);
		const { host } = await createOperationHost(node, { service: "svc" });
		await host.declare({ name: "op", input: ANY, answers: "whole" }, () => ({ outcome: "answered", answer: "a" }));
		await node.exposed.get("svc/op")(request("op"), { delivery, signal: new AbortController().signal });
		assert.deepEqual(node.sent.map((s) => s.payload), expected.map((e) => end(e)), `AGP refusing ${codes.join(", ") || "nothing"}`);
		for (const s of node.sent) {
			assert.equal(s.source, "svc/op", "from the operation's endpoint");
			assert.equal(s.destination, "operation-call/replies", "to the request's source endpoint");
			assert.deepEqual(s.options, { correlationId: ATTEMPT, destinationSelector: { originNodeId: "caller-node", mode: "pinned" } });
		}
	}
	const node = refusingNode(["NO_ROUTE"]);
	const { host } = await createOperationHost(node, { service: "svc" });
	await host.declare({ name: "op", input: ANY, answers: "whole" }, () => { throw new Error("x"); });
	await node.exposed.get("svc/op")(request("op"), { delivery, signal: new AbortController().signal });
	assert.equal(node.sent.length, 1, "a failed end that AGP refuses is not replaced");
});
