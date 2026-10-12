// honest-call-ending - calling a named operation yields exactly one ending: answered, refused with a reason,
// not delivered, or unknown (zorg's target, EM11, EM12, RT7; zorg's E6).
//
// The caller suite's cases for this row run directly against operation-call's own caller, on AGP's
// production in-process carrier with AGP's injected clock and executor barrier and a separate clock for
// the call's bound: answered once; an operation that throws; answers of 30 and 31 levels and one over the
// caller's receive limit; AGP's failures as endings with AGP's code; the two clocks each passing first; a
// deadline and a cancellation after admission; an answer, a refusal, AGP's rejection and AGP's report of
// failure each observed once the bound has passed and before the bound's callback has run, each losing to
// the bound (EM12: an event happens when it occurs on the call's clock); the channel lost before any report,
// after delivered, after failed, and with an answer held until reconnection and released before or after the
// bound; a service, operation or input that is a programming error; every ending's exact fields, frozen; and
// the caller's own clock port throwing at a reading or a timer's cancellation as an answer, a refusal, AGP's
// refusal of the send and the bound decide, each ending once as the observed event decides, through the
// fixture's fault hook, with nothing left waiting and no rejection unhandled (zorg's EM12).
//
// Beside them, on a node whose every answer the test controls: each terminal observation - an answer, a
// refusal, a failed end, AGP's rejection, AGP's report of failure - placed after the bound with the bound's
// callback held back, and just before the bound, where it wins; and a clock port whose cleanup throws, which
// changes no ending and leaves no rejection unhandled (F5 of the first verification). A bound's timer that
// wakes before the deadline on the call's clock is not the bound passing: the call is still waiting, and an
// answer observed just before the true deadline is taken (F1 of the second verification); on the system's
// own clock over the production carrier, the suite's case takes an answer produced just before the bound and
// ends no call before it. A clock whose reading throws once the request is sent cannot show the bound passed:
// each terminal observation then decides, and a later timer changes nothing; with no observation the timer
// still ends the call at its bound.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCaller } from "@apnex/operation-call";
import { registerCallerSuite } from "@apnex/operation-call/caller-suite";
import { controlledCaller, turns } from "../support/controlled-node.js";
import { createFakeNode } from "../support/fake-node.js";
import { directHarness } from "../support/fixture.js";
import { createEarlyWakingClock, createManualCallClock } from "../support/manual-call-clock.js";

registerCallerSuite((name, run) => test(name, { timeout: 30_000 }, run), directHarness, ["honest-call-ending"]);

const CALL = { host: "host-a", service: "svc", operation: "op", input: {}, bound: 100 };
const REFUSAL = { part: "store", code: "moved", what: "w", why: "w", fix: "f", details: {} };

/** Each terminal observation, made on a controlled node once the request is sent, with what it ends as alone. */
const OBSERVATIONS = [
	["an answer", (t) => { t.admit(undefined); return t.reply({ outcome: "answered", answer: 1 }); }, { ending: "answered", answer: 1 }],
	["a refusal", (t) => { t.admit(undefined); return t.reply({ outcome: "refused", refusal: REFUSAL }); }, { ending: "refused", refusal: REFUSAL }],
	["a failed end", (t) => { t.admit(undefined); return t.reply({ outcome: "failed", reason: "operation-failed", agpCode: null }); }, { ending: "unknown", reason: "operation-failed", agpCode: null, deliveryReport: null }],
	["AGP's rejection", (t) => t.reject("NO_ROUTE"), { ending: "not-delivered", agpCode: "NO_ROUTE", proxyCode: null, earlierAttemptsUncertain: false }],
	["a rejection with no AGP code", (t) => t.reject(undefined), { ending: "not-delivered", agpCode: "INTERNAL", proxyCode: null, earlierAttemptsUncertain: false }],
	["AGP's report of failure", (t) => { t.admit(undefined); t.settle([{ kind: "failed", code: "NO_ROUTE" }]); }, { ending: "not-delivered", agpCode: "NO_ROUTE", proxyCode: null, earlierAttemptsUncertain: false }],
	["AGP's report of failure at the receipt", (t) => t.admit({ outcomes: [{ kind: "delivered" }, { kind: "failed", code: "INSTANCE_UNREACHABLE" }] }), { ending: "not-delivered", agpCode: "INSTANCE_UNREACHABLE", proxyCode: null, earlierAttemptsUncertain: false }],
];

/** Watches an invocation's promise. */
function watch(promise) {
	const w = { settled: false, value: undefined, count: 0 };
	promise.then((v) => { w.settled = true; w.value = v; w.count++; });
	return w;
}

for (const [what, observe, alone] of OBSERVATIONS) {
	test(`${what} observed once the bound has passed on the call's clock, before the bound's callback has run, loses to the bound`, async () => {
		const t = await controlledCaller();
		const call = watch(t.caller.invoke(CALL));
		await turns();
		assert.equal(t.sends.length, 1, "the request was sent");
		t.clock.move(100);
		await observe(t);
		await turns();
		assert.equal(call.settled, true, "the observation ends the call");
		assert.deepEqual({ ...call.value, invocation: undefined, attempt: undefined }, { ending: "unknown", invocation: undefined, attempt: undefined, operation: "op", reason: "bound-passed", agpCode: null, deliveryReport: null });
		assert.ok(Object.isFrozen(call.value));
		t.clock.advance(0);
		await turns();
		assert.equal(call.count, 1, "the bound's callback, run late, changes nothing");
	});

	test(`${what} observed 1 ms before the bound decides the ending`, async () => {
		const t = await controlledCaller();
		const call = watch(t.caller.invoke(CALL));
		await turns();
		t.clock.advance(99);
		await observe(t);
		await turns();
		assert.equal(call.settled, true);
		const { invocation, attempt, operation, ...rest } = call.value;
		assert.equal(operation, "op");
		assert.deepEqual(rest, alone);
		t.clock.advance(1);
		await turns();
		assert.equal(call.count, 1);
	});
}

test("a delivery report observed once the bound has passed is not carried into the ending: the bound came first", async () => {
	const t = await controlledCaller();
	const call = watch(t.caller.invoke(CALL));
	await turns();
	t.clock.move(100);
	t.admit({ outcomes: [{ kind: "delivered" }] });
	await turns();
	assert.equal(call.value.reason, "bound-passed");
	assert.equal(call.value.deliveryReport, null, "the report was observed after the bound");
});

test("a delivery report observed before the bound is the ending's delivery report when the bound's callback, run late, ends it", async () => {
	const t = await controlledCaller();
	const call = watch(t.caller.invoke(CALL));
	await turns();
	t.admit({ outcomes: [{ kind: "delivered" }] });
	await turns();
	t.clock.move(150);
	await turns();
	assert.equal(call.settled, false, "nothing observed and the callback held back: no ending yet");
	t.clock.advance(0);
	await turns();
	assert.deepEqual([call.value.reason, call.value.deliveryReport], ["bound-passed", "delivered"]);
});

test("a clock port whose cleanup throws changes no ending, leaves no invocation waiting, and leaves no rejection unhandled", { timeout: 10_000 }, async () => {
	const unhandled = [];
	const listener = (error) => unhandled.push(error);
	process.on("unhandledRejection", listener);
	try {
		let now = 0;
		const timers = [];
		const clock = {
			now: () => now,
			schedule(delayMs, callback) { const timer = { due: now + delayMs, callback }; timers.push(timer); return { cancel() { throw new Error("clock cancel fault"); } }; },
		};
		const rejecting = await createCaller({ node: createFakeNode({ reject: { code: "NO_ROUTE" } }), clock });
		const refused = await rejecting.invoke(CALL);
		assert.deepEqual([refused.ending, refused.agpCode], ["not-delivered", "NO_ROUTE"], "a definite refusal settles though the cleanup throws");
		const t = await controlledCaller({ clock });
		const answered = watch(t.caller.invoke(CALL));
		await turns();
		t.admit(undefined);
		await t.reply({ outcome: "answered", answer: "a" });
		await turns();
		assert.deepEqual([answered.value?.ending, answered.value?.answer], ["answered", "a"]);
		const bounded = watch(t.caller.invoke(CALL));
		await turns();
		now = 100;
		for (const timer of timers.filter((x) => x.due <= now)) timer.callback();
		await turns();
		assert.equal(bounded.value?.reason, "bound-passed", "the bound's callback settles though its own cleanup throws");
		await t.reply({ outcome: "answered", answer: "late" });
		await turns();
		assert.equal(bounded.count, 1, "the late answer finds the invocation decided and removed");
		assert.equal(answered.count, 1);
		assert.deepEqual(unhandled, [], "no rejection went unhandled");
	} finally {
		process.off("unhandledRejection", listener);
	}
});

test("a fault of AGP's node in the caller's reactions leaves the bound to end the call, and no rejection unhandled", { timeout: 10_000 }, async () => {
	const unhandled = [];
	const listener = (error) => unhandled.push(error);
	process.on("unhandledRejection", listener);
	try {
		const t = await controlledCaller();
		const call = watch(t.caller.invoke(CALL));
		await turns();
		// The receipt's reaction reads the message's identifier, which this node fails to give.
		t.sends[0].outcome.resolve({ get messageId() { throw new Error("node fault"); } });
		await turns();
		t.clock.advance(100);
		await turns();
		assert.equal(call.value?.reason, "bound-passed");
		assert.deepEqual(unhandled, []);
	} finally {
		process.off("unhandledRejection", listener);
	}
});

test("a bound's timer waking before the deadline on the call's clock leaves the call waiting, and an answer observed just before the true deadline is taken", { timeout: 10_000 }, async () => {
	const manual = createManualCallClock(0);
	// The timer wakes 0.75 ms before each delay it is given has passed on the clock the caller reads.
	const clock = createEarlyWakingClock(manual, 0.75);
	const t = await controlledCaller({ clock });
	const call = watch(t.caller.invoke(CALL));
	await turns();
	t.admit({ outcomes: [{ kind: "delivered" }] });
	manual.advance(99.25);
	await turns();
	assert.equal(call.settled, false, "the timer woke at 99.25 ms of a bound of 100: the call still waits");
	assert.deepEqual(clock.delays, [100, 1], "the timer was set again for the time left, rounded up");
	manual.move(0.5);
	await t.reply({ outcome: "answered", answer: "just in time" });
	await turns();
	assert.deepEqual([call.value?.ending, call.value?.answer], ["answered", "just in time"], "the answer at 99.75 ms is taken");
	assert.ok(Object.isFrozen(call.value));
	manual.advance(10);
	await turns();
	assert.equal(call.count, 1, "the timer, run later, changes nothing");
	assert.equal(manual.pending(), 0, "no timer is left behind");
});

test("a call clock whose reading throws once the request is sent cannot show the bound passed: each terminal observation decides, and a later timer changes nothing", { timeout: 10_000 }, async () => {
	const variants = [
		["an answer", (t) => { t.admit(undefined); return t.reply({ outcome: "answered", answer: 1 }); }, { ending: "answered", answer: 1 }],
		["a refusal", (t) => { t.admit(undefined); return t.reply({ outcome: "refused", refusal: REFUSAL }); }, { ending: "refused", refusal: REFUSAL }],
		["a failed end", (t) => { t.admit(undefined); return t.reply({ outcome: "failed", reason: "operation-failed", agpCode: null }); }, { ending: "unknown", reason: "operation-failed", agpCode: null, deliveryReport: null }],
		["AGP's rejection", (t) => t.reject("NO_ROUTE"), { ending: "not-delivered", agpCode: "NO_ROUTE", proxyCode: null, earlierAttemptsUncertain: false }],
		["AGP's report of failure", (t) => t.admit({ outcomes: [{ kind: "failed", code: "INSTANCE_UNREACHABLE" }] }), { ending: "not-delivered", agpCode: "INSTANCE_UNREACHABLE", proxyCode: null, earlierAttemptsUncertain: false }],
	];
	for (const [what, observe, expected] of variants) {
		const manual = createManualCallClock(0);
		let broken = false;
		const clock = { now() { if (broken) throw new Error("clock fault"); return manual.now(); }, schedule: (delay, callback) => manual.schedule(delay, callback) };
		const t = await controlledCaller({ clock });
		const call = watch(t.caller.invoke(CALL));
		await turns();
		assert.equal(t.sends.length, 1, `${what}: the request was sent`);
		broken = true;
		manual.move(50);
		await observe(t);
		await turns();
		assert.equal(call.settled, true, `${what}: the observation ends the call`);
		const { invocation, attempt, operation, ...rest } = call.value;
		assert.equal(operation, "op");
		assert.deepEqual(rest, expected, `${what}: the observed event decides`);
		assert.ok(Object.isFrozen(call.value), `${what}: frozen`);
		manual.advance(100);
		await turns();
		assert.equal(call.count, 1, `${what}: the timer, run later, changes nothing`);
	}
	// With nothing observed, a reading that throws at the timer's wakeup leaves nothing to wait on: the call ends at its bound.
	const manual = createManualCallClock(0);
	let broken = false;
	const t = await controlledCaller({ clock: { now() { if (broken) throw new Error("clock fault"); return manual.now(); }, schedule: (delay, callback) => manual.schedule(delay, callback) } });
	const call = watch(t.caller.invoke(CALL));
	await turns();
	broken = true;
	manual.advance(100);
	await turns();
	assert.deepEqual([call.value?.ending, call.value?.reason, call.value?.agpCode], ["unknown", "bound-passed", null]);
});
