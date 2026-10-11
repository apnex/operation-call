// caller-suite-hop-allowance - the caller suite's hop allowance (zorg's D45, EM12; operation-proxy's PX5,
// PX6, PX10), exercised in operation-call itself with an in-process stand-in for a hop
// (test/support/fake-hop.js), so the path operation-proxy takes is not left to operation-proxy alone.
//
// A harness states its allowance: 0 for a direct caller, as every other suite run in these tests does. With
// a stated allowance of 50 ms, the suite runs through a working hop, and each case whose call ends at its
// bound takes the ending the hop carries from the allowance's edge - `unknown`, `bound-passed`, the call
// layer's delivery report - before the caller's own bound passes. Through a hop that holds every ending,
// the suite refuses: with an allowance of 50 because no ending arrives at the edge, and with an allowance of
// 0 because the ending at the bound is `hop-stalled`. The suite never accepts `hop-stalled`.
//
// One case is not run through the hop: "AGP is given the time left on the bound as the send's admission
// deadline". Across a hop, AGP's admission deadline is the time left on the far side's bound, the
// allowance sooner, so that case's check at 99 ms of AGP's clock does not hold there; its call ends at
// AGP's deadline, not at its bound, so D45 does not reach it. It runs directly in caller-chosen-bound.test.js.
import assert from "node:assert/strict";
import { test } from "node:test";
import { callerSuiteRows, registerCallerSuite } from "@apnex/operation-call/caller-suite";
import { fakeHopHarness } from "../support/fake-hop.js";
import { directHarness } from "../support/fixture.js";

const ADMISSION_CASE = "caller-chosen-bound: AGP is given the time left on the bound as the send's admission deadline";

/** Each case of the suite, by its registered name, run against a harness. */
function suiteCases(harness, rows = callerSuiteRows.rows) {
	const cases = new Map();
	registerCallerSuite((name, run) => cases.set(name, run), harness, rows);
	return cases;
}

// Every case but the admission-deadline one, through a working hop with an allowance of 50 ms.
for (const [name, run] of suiteCases(fakeHopHarness({ allowanceMs: 50 }))) {
	if (name === ADMISSION_CASE) continue;
	test(`through a hop with an allowance of 50 ms: ${name}`, { timeout: 30_000 }, run);
}

/** The cases whose call ends at its bound, one from each row that has them. */
const AT_BOUND = [
	"caller-chosen-bound: an admitted invocation whose operation never answers ends unknown exactly once at the caller's bound, and a later answer does not change that",
	"request-correlation: no delivery report is taken for an answer: a report of delivered leaves the call waiting until its bound",
	"honest-call-ending: a handler that runs before its return channel is lost, before any report, ends unknown at the bound with AGP's report of unknown",
	"not-delivered-signal: an attempt that ends unknown followed by one refused outright leaves the invocation's uncertainty standing",
];

test("the cases named as ending at their bound are cases of the suite", () => {
	const names = suiteCases(directHarness);
	for (const name of [...AT_BOUND, ADMISSION_CASE]) assert.ok(names.has(name), name);
});

test("through a hop that holds every ending, with an allowance of 50 ms, a case ending at its bound fails: no ending arrives at the allowance's edge", { timeout: 60_000 }, async () => {
	const cases = suiteCases(fakeHopHarness({ allowanceMs: 50, held: true }));
	for (const name of AT_BOUND.slice(0, 2)) {
		await assert.rejects(cases.get(name)(), /carried across the hop at the allowance's edge/, name);
	}
});

test("through a hop that holds every ending, with an allowance of 0, a case ending at its bound fails: hop-stalled is never accepted", { timeout: 60_000 }, async () => {
	const cases = suiteCases(fakeHopHarness({ allowanceMs: 0, held: true }));
	for (const name of AT_BOUND) {
		await assert.rejects(cases.get(name)(), /the reason: "bound-passed", got "hop-stalled"/, name);
	}
});

test("a harness states its hop allowance as a whole number of milliseconds from 0, or the suite is not registered", () => {
	const register = () => assert.fail("no case is registered");
	const open = directHarness.open;
	for (const hopAllowanceMs of [undefined, -1, 1.5, Number.NaN, Infinity, "50", null]) {
		assert.throws(() => registerCallerSuite(register, { open, hopAllowanceMs }), RangeError, String(hopAllowanceMs));
	}
	assert.throws(() => registerCallerSuite(register, { hopAllowanceMs: 0 }), TypeError, "a harness with no open");
	assert.throws(() => registerCallerSuite(register, { open, hopAtBound: true }), RangeError, "the earlier hopAtBound states no allowance");
	let count = 0;
	assert.equal(registerCallerSuite(() => { count++; }, { open, hopAllowanceMs: 0 }), count);
	assert.ok(count > 0);
});
