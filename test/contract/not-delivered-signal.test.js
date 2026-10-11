// not-delivered-signal - "not delivered" is reported only when AGP refused the attempt outright, so that
// attempt had no effect; it proves nothing about earlier attempts of the same invocation, whose
// uncertainty stands (zorg's target, EM12; operation-call's D2; zorg's E6, AGP's second, fourth and fifth
// consumer-handoff cases).
//
// The caller suite's cases for this row run directly against operation-call's own caller: an admission
// deadline passing, and a cancellation, while the send is queued behind AGP's executor, after which the
// request never arrives; a route observed reachable and withdrawn before the send; an unknown attempt
// followed by one refused outright, its uncertainty standing; a named invocation that is no repeat; and a
// request over the peer's receive limit beside other calls. Beside them: the exact fields of the ending.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCaller } from "@apnex/operation-call";
import { registerCallerSuite } from "@apnex/operation-call/caller-suite";
import { createCreepingClock, createFakeNode } from "../support/fake-node.js";
import { directHarness } from "../support/fixture.js";

registerCallerSuite((name, run) => test(name, { timeout: 30_000 }, run), directHarness, ["not-delivered-signal"]);

test("a not-delivered ending holds exactly its address, AGP's code unchanged, no proxy code, and whether earlier attempts are uncertain", async () => {
	const node = createFakeNode({ reject: { code: "INSTANCE_UNREACHABLE" } });
	const caller = await createCaller({ node, clock: createCreepingClock(0) });
	const call = { host: "host-a", service: "svc", operation: "op", input: {}, bound: 100 };
	const fresh = await caller.invoke(call);
	assert.deepEqual(Object.keys(fresh).sort(), ["agpCode", "attempt", "earlierAttemptsUncertain", "ending", "invocation", "operation", "proxyCode"]);
	assert.deepEqual({ ...fresh, invocation: undefined, attempt: undefined }, {
		ending: "not-delivered", invocation: undefined, attempt: undefined, operation: "op", agpCode: "INSTANCE_UNREACHABLE", proxyCode: null, earlierAttemptsUncertain: false,
	});
	const repeated = await caller.invoke({ ...call, invocation: fresh.invocation, repeat: true });
	assert.equal(repeated.earlierAttemptsUncertain, true, "a repeat says an earlier attempt may have taken effect");
	assert.equal(repeated.invocation, fresh.invocation);
	assert.ok(Object.isFrozen(repeated), "an ending cannot be changed afterwards");
});
