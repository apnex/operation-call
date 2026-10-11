// serve-named-operations - a host exposes declared operations by name, and every invocation gets exactly
// one ending even when the operation fails (zorg's target, EM10, EM11; zorg's D7; zorg's E8).
//
// Cases: each declared operation at its own AGP endpoint, observed in AGP's route view, with two hosts
// advertising the same names; an undeclared operation refused by AGP before any handler or evidence runs;
// an operation that throws, rejects, or gives no valid result ending failed with operation-failed; an answer
// that cannot cross AGP whole - not JSON, an unsafe integer, 31 levels - replaced by answer-not-sendable
// with no AGP code; and an answer whose send AGP refuses replaced once by answer-not-sendable with AGP's
// code, nothing sent when that fails too; a getter or a proxy that throws on the result, or nested in its
// refusal or answer, ending failed with operation-failed and no AGP code, before the caller's bound, a result
// read once; and an object reached by two paths in an answer or a refusal read once, its first snapshot sent
// in every place, a second read that would give a value that is not JSON or throw never happening (F2 of the
// second verification). Two hosts pinned apart are the suite's advertiser-instance-select.
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

// Reading what an operation returned is inside its failure boundary (EM11; F4 of the first verification):
// a getter or a proxy that throws, on the result or nested in its refusal or answer, gives one
// operation-failed end, with no AGP code, before the caller's bound; what is read is read once.
const thrower = () => { throw new Error("a malformed result"); };
const MALFORMED_RESULTS = [
	["a result whose outcome getter throws", () => ({ get outcome() { return thrower(); }, answer: null })],
	["a result whose answer getter throws", () => ({ outcome: "answered", get answer() { return thrower(); } })],
	["a proxy whose get trap throws", () => new Proxy({ outcome: "answered", answer: 1 }, { get: thrower })],
	["a proxy whose ownKeys trap throws", () => new Proxy({ outcome: "answered", answer: 1 }, { ownKeys: thrower })],
	["a result whose then getter throws", () => ({ outcome: "answered", answer: 1, get then() { return thrower(); } })],
	["a refusal whose details getter throws", () => ({ outcome: "refused", refusal: { part: "p", code: "c", what: "w", why: "w", fix: "f", get details() { return thrower(); } } })],
	["a refusal that is a proxy whose get trap throws", () => ({ outcome: "refused", refusal: new Proxy({ part: "p", code: "c", what: "w", why: "w", fix: "f", details: {} }, { get: thrower }) })],
	["a refusal whose misfit record's getter throws", () => ({ outcome: "refused", refusal: { part: "p", code: "c", what: "w", why: "w", fix: "f", details: {}, misfits: [{ pointer: "", keyword: "type", expected: "string", get fit() { return thrower(); } }] } })],
	["a refusal whose details hold a getter that throws", () => ({ outcome: "refused", refusal: { part: "p", code: "c", what: "w", why: "w", fix: "f", details: { get n() { return thrower(); } } } })],
	["an answer holding a getter that throws", () => ({ outcome: "answered", answer: { list: [1, { get x() { return thrower(); } }] } })],
];

test("a getter or a proxy that throws on what an operation returned, or in its refusal or answer, gives exactly one operation-failed end with no AGP code", async (t) => {
	const raw = await openRaw(t, { declare: (host) => host.declare({ name: "op", input: ANY, answers: "whole" }, (input) => MALFORMED_RESULTS[input][1]()), endpoints: ["svc/op"] });
	for (let i = 0; i < MALFORMED_RESULTS.length; i++) {
		const attempt = `${INVOCATION}.000001${String(i).padStart(2, "0")}`;
		await raw.send("svc/op", request("op", i, { attempt }), attempt);
	}
	await raw.repliesReach(MALFORMED_RESULTS.length);
	for (let i = 0; i < 50; i++) await turn();
	assert.equal(raw.replies.length, MALFORMED_RESULTS.length, "exactly one end message for each request");
	for (const { payload } of raw.replies) {
		const i = Number(payload.attempt.slice(-2));
		assert.deepEqual(payload, end({ outcome: "failed", reason: "operation-failed", agpCode: null }, payload.attempt), MALFORMED_RESULTS[i][0]);
	}
});

test("a result read through getters is read once: what the host judges is what it sends", async (t) => {
	let outcomeReads = 0;
	let answerReads = 0;
	const raw = await openRaw(t, { declare: (host) => host.declare({ name: "op", input: ANY, answers: "whole" }, () => ({
		get outcome() { return ++outcomeReads === 1 ? "answered" : "refused"; },
		get answer() { return ++answerReads === 1 ? { n: 1 } : { n: 9007199254740992 }; },
	})), endpoints: ["svc/op"] });
	await raw.send("svc/op", request("op", 0));
	await raw.repliesReach(1);
	assert.deepEqual(raw.replies[0].payload, end({ outcome: "answered", answer: { n: 1 } }));
	assert.deepEqual([outcomeReads, answerReads], [1, 1]);
});

test("an object reached by two paths in an answer or a refusal is read once: its first snapshot is sent in every place, and a second read never happens", async (t) => {
	let answerReads = 0;
	let refusalReads = 0;
	const sharedAnswer = { get n() { return ++answerReads === 1 ? 7 : Number.NaN; } };
	const sharedDetails = { get n() { if (++refusalReads > 1) throw new Error("a second read"); return 1; } };
	const refusal = { part: "p", code: "c", what: "w", why: "w", fix: "f", details: { first: sharedDetails, list: [sharedDetails, { again: sharedDetails }] } };
	const raw = await openRaw(t, { declare: (host) => host.declare({ name: "op", input: ANY, answers: "whole" }, (input) => input === 0
		? { outcome: "answered", answer: { first: sharedAnswer, second: [sharedAnswer, sharedAnswer] } }
		: { outcome: "refused", refusal }), endpoints: ["svc/op"] });
	await raw.send("svc/op", request("op", 0));
	await raw.repliesReach(1);
	const second = `${INVOCATION}.00000201`;
	await raw.send("svc/op", request("op", 1, { attempt: second }), second);
	await raw.repliesReach(2);
	assert.deepEqual(raw.replies[0].payload, end({ outcome: "answered", answer: { first: { n: 7 }, second: [{ n: 7 }, { n: 7 }] } }), "the answer, not answer-not-sendable");
	assert.deepEqual(raw.replies[1].payload, end({ outcome: "refused", refusal: { ...refusal, details: { first: { n: 1 }, list: [{ n: 1 }, { again: { n: 1 } }] } } }, second), "the refusal, not operation-failed");
	assert.deepEqual([answerReads, refusalReads], [1, 1], "each getter read exactly once");
});

test("over AGP, a result whose inspection throws ends the caller's invocation unknown with operation-failed and no AGP code, before its bound", async (t) => {
	const topology = await openTopology();
	t.after(() => topology.close());
	const { host } = await createOperationHost(topology.hosts[0].node, { service: "svc" });
	await host.declare({ name: "op", input: ANY, answers: "whole" }, (input) => MALFORMED_RESULTS[input][1]());
	await topology.hooks.ready("host-a", "svc/op");
	for (let i = 0; i < MALFORMED_RESULTS.length; i++) {
		// The call clock is never advanced: an ending at the bound could not come.
		const ending = await topology.caller.invoke({ host: "host-a", service: "svc", operation: "op", input: i, bound: 100 });
		assert.deepEqual([ending.ending, ending.reason, ending.agpCode], ["unknown", "operation-failed", null], MALFORMED_RESULTS[i][0]);
	}
	assert.equal(topology.callClock.pending(), 0, "every bound's timer was cancelled by an ending before it");
});
