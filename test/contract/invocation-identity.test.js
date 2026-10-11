// invocation-identity - every invocation carries an identity that stays the same when it is repeated, so
// the owner of an effect can recognise the repeat; it travels in operation-call's own envelope (zorg's
// target, EM11, EM7; zorg's D4).
//
// The caller suite's cases for this row run directly against operation-call's own caller: the identity's
// form, given to the operation with the attempt; a repeat carrying the same identity under a new attempt.
// Beside them, with an injected identity source: the identity is exactly the caller's wall-clock time in 13
// digits, a hyphen and 16 random lowercase hexadecimal digits; each attempt adds a dot and 8 more, new for
// every attempt; and an identity that is not as EM11 writes it is refused before anything is sent.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCaller } from "@apnex/operation-call";
import { registerCallerSuite } from "@apnex/operation-call/caller-suite";
import { createCreepingClock, createFakeNode } from "../support/fake-node.js";
import { directHarness, openTopology } from "../support/fixture.js";

registerCallerSuite((name, run) => test(name, { timeout: 30_000 }, run), directHarness, ["invocation-identity"]);

/** An identity source with a set wall-clock time, giving hexadecimal digits from a counter. */
function source(wallTimeMs) {
	let n = 0;
	return {
		wallTimeMs: () => wallTimeMs,
		randomHex: (digits) => (++n).toString(16).padStart(digits, "0"),
	};
}

const call = { host: "host-a", service: "svc", operation: "op", input: {}, bound: 100 };

test("an invocation identity is the caller's wall-clock milliseconds in 13 digits, a hyphen and 16 hexadecimal digits; an attempt adds a dot and 8", async () => {
	const node = createFakeNode();
	const caller = await createCaller({ node, clock: createCreepingClock(0), identities: source(1791540000000.9) });
	const ending = await caller.invoke(call);
	assert.equal(ending.invocation, "1791540000000-0000000000000001", "the time floored to a millisecond");
	assert.equal(ending.attempt, "1791540000000-0000000000000001.00000002");
	assert.equal(node.sends[0].payload.invocation, ending.invocation, "carried in operation-call's envelope");
	assert.equal(node.sends[0].payload.attempt, ending.attempt);
	assert.equal(caller.newInvocation(), "1791540000000-0000000000000003", "a caller can name an invocation before invoking");
});

test("a time of fewer than 13 digits is written in 13; a time that needs more, or a non-hexadecimal random source, is a fault of the port", async () => {
	const early = await createCaller({ node: createFakeNode(), clock: createCreepingClock(0), identities: source(5) });
	assert.equal((await early.invoke(call)).invocation, "0000000000005-0000000000000001");
	const late = await createCaller({ node: createFakeNode(), clock: createCreepingClock(0), identities: source(10000000000000) });
	await assert.rejects(late.invoke(call), RangeError);
	const bad = await createCaller({ node: createFakeNode(), clock: createCreepingClock(0), identities: { wallTimeMs: () => 1, randomHex: (d) => "G".repeat(d) } });
	await assert.rejects(bad.invoke(call), TypeError);
});

test("a repeat keeps the invocation identity given and makes a new attempt identity for every attempt", async () => {
	const node = createFakeNode();
	const caller = await createCaller({ node, clock: createCreepingClock(0), identities: source(1791540000000) });
	const invocation = "1791539999999-abcdef0123456789";
	const one = await caller.invoke({ ...call, invocation, repeat: true });
	const two = await caller.invoke({ ...call, invocation, repeat: true });
	assert.equal(one.invocation, invocation);
	assert.equal(two.invocation, invocation);
	assert.notEqual(one.attempt, two.attempt);
	assert.ok(one.attempt.startsWith(`${invocation}.`) && two.attempt.startsWith(`${invocation}.`));
	assert.deepEqual(node.sends.map((s) => s.payload.invocation), [invocation, invocation]);
});

test("an invocation identity not as EM11 writes it is refused before anything is sent", async () => {
	const node = createFakeNode();
	const caller = await createCaller({ node, clock: createCreepingClock(0) });
	for (const invocation of ["", "1791540000000-ABCDEF0123456789", "179154000000-abcdef0123456789", "1791540000000-abcdef012345678", "1791540000000_abcdef0123456789", 17]) {
		await assert.rejects(caller.invoke({ ...call, invocation }), TypeError, String(invocation));
	}
	assert.equal(node.sends.length, 0);
});

test("over AGP, the operation receives the invocation identity from the envelope, never from the input", async (t) => {
	const topology = await openTopology({ identities: source(1791540000000) });
	t.after(() => topology.close());
	const { createOperationHost } = await import("@apnex/operation-call");
	const opening = await createOperationHost(topology.hosts[0].node, { service: "svc" });
	const seen = [];
	await opening.host.declare({ name: "op", input: { $schema: "urn:apnex:shape-check:dialect:1" }, answers: "whole" }, (input, context) => {
		seen.push({ input, invocation: context.invocation, attempt: context.attempt });
		return { outcome: "answered", answer: null };
	});
	await topology.hooks.ready("host-a", "svc/op");
	const ending = await topology.caller.invoke({ ...call, input: { invocation: "1111111111111-1111111111111111" } });
	assert.equal(ending.ending, "answered");
	assert.deepEqual(seen, [{ input: { invocation: "1111111111111-1111111111111111" }, invocation: "1791540000000-0000000000000001", attempt: "1791540000000-0000000000000001.00000002" }]);
});
