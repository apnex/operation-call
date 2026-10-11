// caller-chosen-bound - the caller sets the bound: a whole number of milliseconds from 1 to 2147483647,
// starting when it invokes, on operation-call's own clock port apart from AGP's (zorg's target, EM12;
// zorg's E6). Answers in parts, and so their time to the next sign of life, are deferred (zorg's D15).
//
// The caller suite's cases for this row run directly against operation-call's own caller: an admitted
// invocation never answered ends unknown exactly once at the bound, a later answer changing nothing; the
// bound runs on the caller's clock, not AGP's; AGP's admission deadline is the time left, the bound less the
// hop allowance across a hop (zorg's D46); the largest and smallest bounds; time spent preparing counts
// against the bound, which starts as the caller invokes; on the system's own clock, an answer produced after
// the bound by a host occupying its thread loses to the bound (EM12); and a bound outside its range throws a
// RangeError with nothing sent. Beside them, on nodes the test controls: the time left rounded up to a whole
// millisecond and at least 1, not extending the call's own bound; a bound that passes while preparing ends
// the call at the bound with nothing sent; and the caller's abort signal given to AGP for the send alone.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCaller } from "@apnex/operation-call";
import { registerCallerSuite } from "@apnex/operation-call/caller-suite";
import { controlledCaller, turns } from "../support/controlled-node.js";
import { createCreepingClock, createFakeNode } from "../support/fake-node.js";
import { createManualCallClock } from "../support/manual-call-clock.js";
import { directHarness } from "../support/fixture.js";

registerCallerSuite((name, run) => test(name, { timeout: 30_000 }, run), directHarness, ["caller-chosen-bound"]);

const call = (bound) => ({ host: "host-a", service: "svc", operation: "op", input: {}, bound });

test("AGP is given the time left on the bound, rounded up to a whole millisecond, as the send's admission deadline", { timeout: 10_000 }, async () => {
	const node = createFakeNode();
	// The clock moves 0.25 ms at every reading, so time passes between invoking and sending.
	const caller = await createCaller({ node, clock: createCreepingClock(0.25) });
	await caller.invoke(call(10));
	const left = node.sends[0].options.timeoutMs;
	assert.ok(Number.isInteger(left), "a whole number of milliseconds");
	assert.equal(left, 10, "10 ms less a fraction, rounded up");
	await caller.invoke(call(2147483647));
	assert.equal(node.sends[1].options.timeoutMs, 2147483647, "the largest bound, less a fraction, rounded up");
});

test("AGP's admission deadline is at least 1 ms, and does not extend the call's own bound", { timeout: 10_000 }, async () => {
	// Reading the input moves the call's clock 0.75 ms, so a quarter of a millisecond is left once prepared.
	const t = await controlledCaller();
	let read = false;
	const input = { get v() { if (!read) { read = true; t.clock.move(0.75); } return 1; } };
	const ending = t.caller.invoke({ ...call(1), input });
	await turns();
	assert.equal(t.last().options.timeoutMs, 1, "a quarter of a millisecond, rounded up");
	t.clock.advance(0.25);
	const result = await ending;
	assert.deepEqual([result.ending, result.reason], ["unknown", "bound-passed"], "the call ends at its own bound, 1 ms after invoking, before AGP's deadline");
});

test("a bound that passes while the caller prepares the invocation ends it unknown at the bound, and nothing is sent", { timeout: 10_000 }, async () => {
	// The identity source moves the call's clock past the bound as the caller makes the invocation identity.
	const clock = createManualCallClock(0);
	let n = 0;
	const identities = { wallTimeMs: () => 1791540000000, randomHex(d) { if (++n === 1) clock.advance(101); return "1".repeat(d); } };
	const node = createFakeNode();
	const caller = await createCaller({ node, clock, identities });
	const ending = await caller.invoke(call(100));
	assert.deepEqual(ending, { ending: "unknown", invocation: "1791540000000-1111111111111111", attempt: "1791540000000-1111111111111111.11111111", operation: "op", reason: "bound-passed", agpCode: null, deliveryReport: null });
	assert.ok(Object.isFrozen(ending));
	assert.equal(node.sends.length, 0, "nothing was sent");
	assert.equal(clock.pending(), 0, "no timer was left behind");
});

test("a request found not sendable after the bound passed while preparing ends at the bound: the bound came first", { timeout: 10_000 }, async () => {
	const clock = createManualCallClock(0);
	let read = false;
	const input = { get big() { if (!read) { read = true; clock.move(100); } return 2 ** 60; } };
	const node = createFakeNode();
	const caller = await createCaller({ node, clock });
	const ending = await caller.invoke({ ...call(100), input });
	assert.deepEqual([ending.ending, ending.reason], ["unknown", "bound-passed"]);
	assert.equal(node.sends.length, 0);
	const sendable = await caller.invoke({ ...call(100), input: 2 ** 60 });
	assert.deepEqual([sendable.ending, sendable.refusal.code], ["refused", "not-sendable"], "with time left, the same input is refused before sending");
});

test("the bound starts as invoke is entered: the time spent checking and preparing is not given to AGP", { timeout: 10_000 }, async () => {
	const clock = createManualCallClock(0);
	const node = createFakeNode();
	const caller = await createCaller({ node, clock });
	let read = false;
	const input = { get slow() { if (!read) { read = true; clock.move(40); } return 1; } };
	await caller.invoke({ ...call(100), input });
	assert.equal(node.sends[0].options.timeoutMs, 60, "100 ms less the 40 ms spent reading the input");
});

test("the caller's abort signal is passed to AGP for the send, with the attempt as the correlation label, pinned to the named host", { timeout: 10_000 }, async () => {
	const node = createFakeNode();
	const caller = await createCaller({ node, clock: createCreepingClock(0) });
	const controller = new AbortController();
	const ending = await caller.invoke({ ...call(100), signal: controller.signal });
	const { source, destination, options } = node.sends[0];
	assert.equal(source, "operation-call/replies");
	assert.equal(destination, "svc/op");
	assert.equal(options.signal, controller.signal, "the caller's own signal");
	assert.equal(options.correlationId, ending.attempt, "the attempt identity is the correlation label");
	assert.deepEqual(options.destinationSelector, { originNodeId: "host-a", mode: "pinned" });
	await caller.invoke(call(100));
	assert.equal(Object.hasOwn(node.sends[1].options, "signal"), false, "no signal is passed when the caller gave none");
});
