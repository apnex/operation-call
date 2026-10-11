// caller-chosen-bound - the caller sets the bound: a whole number of milliseconds from 1 to 2147483647,
// starting when it invokes, on operation-call's own clock port apart from AGP's (zorg's target, EM12;
// zorg's E6). Answers in parts, and so their time to the next sign of life, are deferred (zorg's D15).
//
// The caller suite's cases for this row run directly against operation-call's own caller: an admitted
// invocation never answered ends unknown exactly once at the bound, a later answer changing nothing; the
// bound runs on the caller's clock, not AGP's; AGP's admission deadline is the time left; and the largest
// and smallest bounds. Beside them: the bound's range, and the time left rounded up to a whole millisecond
// and at least 1, given to AGP with the caller's abort signal for the send alone.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCaller } from "@apnex/operation-call";
import { registerCallerSuite } from "@apnex/operation-call/caller-suite";
import { createCreepingClock, createFakeNode } from "../support/fake-node.js";
import { directHarness } from "../support/fixture.js";

registerCallerSuite((name, run) => test(name, { timeout: 30_000 }, run), directHarness, ["caller-chosen-bound"]);

const call = (bound) => ({ host: "host-a", service: "svc", operation: "op", input: {}, bound });

test("a bound outside 1 to 2147483647 whole milliseconds is the caller's programming error, rejected before anything is sent", async () => {
	const node = createFakeNode();
	const caller = await createCaller({ node, clock: createCreepingClock(0) });
	for (const bound of [0, -1, 2147483648, 1.5, Number.NaN, Infinity, "5", undefined]) {
		await assert.rejects(caller.invoke(call(bound)), RangeError, `bound ${String(bound)}`);
	}
	assert.equal(node.sends.length, 0, "nothing was sent");
	for (const bound of [1, 2147483647]) {
		const ending = await caller.invoke(call(bound));
		assert.equal(ending.ending, "not-delivered", `bound ${bound} is accepted and the call reaches AGP`);
	}
	assert.equal(node.sends.length, 2);
});

test("AGP is given the time left on the bound, rounded up to a whole millisecond, as the send's admission deadline", async () => {
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

test("AGP's admission deadline is at least 1 ms, even when the bound has passed by the time of sending", async () => {
	const node = createFakeNode();
	const caller = await createCaller({ node, clock: createCreepingClock(5) });
	await caller.invoke(call(1));
	assert.equal(node.sends[0].options.timeoutMs, 1);
});

test("the caller's abort signal is passed to AGP for the send, with the attempt as the correlation label, pinned to the named host", async () => {
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
