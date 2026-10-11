// message-format - operation-call's messages (zorg's target, EM11; zorg's D8, D9; zorg's E7).
//
// Every message is a JSON object holding `operationCall` 1, `type`, and exactly the fields its type names.
// E7: a part followed by an end encodes and decodes in the format, carried across AGP's production
// in-process carrier, though no operation answers in parts. Beside it: EM11's example request reads as a
// request; a message breaking the form in any field is not read; and the limits a message keeps to cross
// AGP whole - 30 levels, safe integers, and a request message of at most 16777216 bytes of UTF-8 - at
// their boundaries.
import assert from "node:assert/strict";
import { test } from "node:test";
import { crossesAgp, MESSAGE_LIMITS, messageBytes, readMessage, requestSendable, writeEnd, writePart, writeRequest } from "@apnex/operation-call/message-format";
import { openTopology, until } from "../support/fixture.js";

const address = { invocation: "1791540000000-3f9a0c1d2b4e5f60", attempt: "1791540000000-3f9a0c1d2b4e5f60.a1b2c3d4", operation: "update" };
const refusal = { part: "entity-store", code: "revision-moved", what: "w", why: "y", fix: "f", details: { expected: 1, current: 2 } };

test("E7: a part followed by an end encodes, crosses AGP, and decodes in operation-call's message format", async (t) => {
	const topology = await openTopology({ makeCaller: false });
	t.after(() => topology.close());
	const received = [];
	await topology.callerNode.expose("operation-call/replies", async (payload) => { received.push(payload); });
	await topology.hosts[0].node.expose("svc/update", async () => {});
	await topology.hooks.ready("host-a", "svc/update");
	const part = writePart(address, 1, { first: [1, 2] });
	const end = writeEnd(address, { outcome: "answered", answer: { last: true } });
	assert.deepEqual(part, { operationCall: 1, type: "part", ...address, sequence: 1, answer: { first: [1, 2] } });
	assert.deepEqual(end, { operationCall: 1, type: "end", ...address, outcome: "answered", answer: { last: true } });
	for (const message of [part, end]) {
		await topology.hosts[0].node.send("svc/update", "operation-call/replies", message, { correlationId: address.attempt, destinationSelector: { originNodeId: "caller", mode: "pinned" } });
	}
	await until(() => received.length === 2, "both messages");
	assert.deepEqual(received, [part, end], "in order and unchanged");
	assert.deepEqual(received.map(readMessage), [part, end], "each decodes as its own type");
	assert.equal(readMessage(JSON.parse(JSON.stringify(part))).type, "part");
	assert.equal(readMessage(JSON.parse(JSON.stringify(end))).type, "end");
});

test("EM11's example request reads as a request; each kind of end reads; the writers write exactly the fields each type names", () => {
	const example = JSON.parse('{ "operationCall": 1, "type": "request", "invocation": "1791540000000-3f9a0c1d2b4e5f60", "attempt": "1791540000000-3f9a0c1d2b4e5f60.a1b2c3d4", "operation": "update", "input": {} }');
	assert.deepEqual(readMessage(example), example);
	assert.deepEqual(writeRequest(address, {}), example);
	assert.deepEqual(writeEnd(address, { outcome: "refused", refusal }), { operationCall: 1, type: "end", ...address, outcome: "refused", refusal });
	assert.deepEqual(writeEnd(address, { outcome: "failed", reason: "operation-failed", agpCode: null }), { operationCall: 1, type: "end", ...address, outcome: "failed", reason: "operation-failed", agpCode: null });
	for (const content of [{ outcome: "refused", refusal }, { outcome: "failed", reason: "operation-failed", agpCode: null }, { outcome: "failed", reason: "answer-not-sendable", agpCode: "MESSAGE_TOO_LARGE" }, { outcome: "answered", answer: null }]) {
		assert.ok(readMessage(writeEnd(address, content)), content.outcome);
	}
});

test("a message breaking the form in any field is not read", () => {
	const request = writeRequest(address, {});
	const end = writeEnd(address, { outcome: "answered", answer: 1 });
	const without = (m, f) => { const c = { ...m }; delete c[f]; return c; };
	const broken = [
		null, [], "request", { ...request, operationCall: 2 }, { ...request, operationCall: "1" }, { ...request, type: "reply" },
		{ ...request, extra: 1 }, without(request, "input"), without(request, "operation"), { ...request, operation: "Update" },
		{ ...request, invocation: "1791540000000-3F9A0C1D2B4E5F60" }, { ...request, attempt: "1791540000001-3f9a0c1d2b4e5f60.a1b2c3d4" },
		{ ...request, attempt: "1791540000000-3f9a0c1d2b4e5f60" }, { ...request, input: Number.NaN },
		without(end, "answer"), { ...end, outcome: "done" }, { ...end, refusal },
		writeEnd(address, { outcome: "refused", refusal: { ...refusal, extra: 1 } }), writeEnd(address, { outcome: "refused", refusal: without(refusal, "fix") }),
		writeEnd(address, { outcome: "failed", reason: "crashed", agpCode: null }), writeEnd(address, { outcome: "failed", reason: "operation-failed", agpCode: 7 }),
		without(writeEnd(address, { outcome: "failed", reason: "operation-failed", agpCode: null }), "agpCode"),
		// EM11 renamed the failed reason operation-failed; the earlier name is no longer the format's.
		writeEnd(address, { outcome: "failed", reason: "operation-threw", agpCode: null }),
		writePart(address, 0, 1), writePart(address, 1.5, 1), without(writePart(address, 1, 1), "sequence"),
	];
	for (const message of broken) assert.equal(readMessage(message), undefined, JSON.stringify(message));
});

test("a message crosses AGP whole at 30 levels, the message counted, and not at 31; nor with an integer beyond 9007199254740991 from zero", () => {
	assert.equal(MESSAGE_LIMITS.depth, 30);
	const nested = (n) => { let v = 0; for (let i = 0; i < n; i++) v = [v]; return v; };
	assert.equal(crossesAgp(writeRequest(address, nested(29))), true);
	assert.equal(crossesAgp(writeRequest(address, nested(30))), false);
	assert.equal(crossesAgp(writeEnd(address, { outcome: "answered", answer: nested(29) })), true);
	assert.equal(crossesAgp(writeEnd(address, { outcome: "answered", answer: nested(30) })), false);
	assert.equal(crossesAgp(writeRequest(address, { a: {} })), true, "an empty object is a level, and 3 levels cross");
	assert.equal(crossesAgp(writeRequest(address, nested(100000))), false, "a deep request is judged without overflowing the stack");
	assert.equal(crossesAgp(writeRequest(address, [9007199254740991, -9007199254740991])), true);
	assert.equal(crossesAgp(writeRequest(address, [9007199254740992])), false);
	assert.equal(crossesAgp(writeRequest(address, -9007199254740992)), false);
	assert.equal(crossesAgp(writeRequest(address, 1e300)), false, "an integer far beyond the range");
	assert.equal(crossesAgp(writeRequest(address, 0.5)), true);
});

test("a request message of exactly 16777216 bytes of UTF-8 may be sent, and of one byte more may not, multi-byte characters counted as bytes", () => {
	assert.equal(MESSAGE_LIMITS.requestBytes, 16777216);
	const overhead = messageBytes(writeRequest(address, ""));
	const ascii = (n) => writeRequest(address, "x".repeat(n - overhead));
	assert.equal(messageBytes(ascii(16777216)), 16777216);
	assert.equal(requestSendable(ascii(16777216)), true);
	assert.equal(requestSendable(ascii(16777217)), false);
	const twoByte = (n) => writeRequest(address, `${"x".repeat(n - overhead - 2)}\u00e9`);
	assert.equal(messageBytes(twoByte(16777216)), 16777216, "\u00e9 is two bytes");
	assert.equal(requestSendable(twoByte(16777216)), true);
	assert.equal(requestSendable(twoByte(16777217)), false);
	assert.equal(requestSendable(writeRequest(address, [9007199254740992])), false, "an unsafe integer is never sendable");
});

test("over AGP: requests and answers of 30 levels cross and of 31 do not; request messages of 16777216 bytes reach AGP and of one more do not; a request over the peer's receive limit and an answer over the caller's", async (t) => {
	const topology = await openTopology();
	t.after(() => topology.close());
	const { createOperationHost } = await import("@apnex/operation-call");
	const { host } = await createOperationHost(topology.hosts[0].node, { service: "svc" });
	const any = { $schema: "urn:apnex:shape-check:dialect:1" };
	await host.declare({ name: "echo", input: any, answers: "whole" }, (input) => ({ outcome: "answered", answer: input }));
	await host.declare({ name: "deeper", input: any, answers: "whole" }, (input) => ({ outcome: "answered", answer: [input] }));
	await host.declare({ name: "sized", input: any, answers: "whole" }, (input) => ({ outcome: "answered", answer: "x".repeat(input) }));
	for (const op of ["echo", "deeper", "sized"]) await topology.hooks.ready("host-a", `svc/${op}`);
	const call = (operation, input) => topology.caller.invoke({ host: "host-a", service: "svc", operation, input, bound: 10_000 });
	const nested = (n) => { let v = 0; for (let i = 0; i < n; i++) v = [v]; return v; };
	const outcome = (e) => [e.ending, e.refusal?.code ?? e.agpCode ?? null, e.reason ?? null];
	assert.deepEqual(outcome(await call("echo", nested(29))), ["answered", null, null], "a request and an answer of 30 levels");
	assert.deepEqual(outcome(await call("echo", nested(30))), ["refused", "not-sendable", null], "a request of 31 levels");
	assert.deepEqual(outcome(await call("deeper", nested(29))), ["unknown", null, "answer-not-sendable"], "an answer of 31 levels");
	const overhead = messageBytes(writeRequest({ ...address, operation: "echo" }, ""));
	assert.deepEqual(outcome(await call("echo", "x".repeat(16777216 - overhead))), ["not-delivered", "MESSAGE_TOO_LARGE", null], "a request message of 16777216 bytes reaches AGP, which refuses it");
	assert.deepEqual(outcome(await call("echo", "x".repeat(16777217 - overhead))), ["refused", "not-sendable", null], "one byte more never reaches AGP");
	assert.deepEqual(outcome(await call("echo", "x".repeat(2_000_000))), ["not-delivered", "MESSAGE_TOO_LARGE", null], "within 16777216 bytes but over the peer's receive limit");
	assert.deepEqual(outcome(await call("sized", 2_000_000)), ["unknown", "MESSAGE_TOO_LARGE", "answer-not-sendable"], "an answer over the caller's receive limit");
	assert.deepEqual(outcome(await call("echo", "after")), ["answered", null, null], "a call after them all is answered");
});
