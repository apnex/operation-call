// cancel-invocation - a caller may end an invocation early, and the operation is told (zorg's target, EM11,
// EM12; zorg's D64; Delta 4's D4-E4).
//
// The caller suite's cases for this row run directly against operation-call's own caller over AGP's
// production in-process carrier. Beside them, on a controlled host: a cancel firing the operation's signal,
// one reaching the host while the evidence port is held leaving the signal fired as the operation starts; and
// a cancel or an alive from another node, naming another operation or invocation, under an attempt not
// recorded or finished, or with a field missing or added, discarded unanswered with the evidence port not
// asked. And on a controlled caller node: an abort after admission submitting one cancel and fixing the
// deadline, the call then ending by the host's end, or a bound after its last sign of life while the host
// keeps sending alive; an abort between admission and its receipt submitting the cancel when the receipt
// arrives; an abort before admission ending not delivered with ABORTED and submitting nothing; an abort after
// the ending changing nothing; a call accepting parts ending at its deadline or with part-missing submitting
// one cancel, its admission observed only after the ending included; and an abort followed by the deadline
// submitting one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerCallerSuite } from "@apnex/operation-call/caller-suite";
import { controlledCaller, deliverTo, turns } from "../support/controlled-node.js";
import { controlOf, controlledHost, newAttempt, requestOf } from "../support/controlled-host.js";
import { directHarness } from "../support/fixture.js";

registerCallerSuite((name, run) => test(name, { timeout: 30_000 }, run), directHarness, ["cancel-invocation"]);

/** Watches a promise's settling. */
function watch(promise) {
	const w = { settled: false, value: undefined, count: 0 };
	promise.then((v) => { w.settled = true; w.value = v; w.count++; }, () => { w.settled = true; w.count++; });
	return w;
}

/** A host whose `wait` operation, whole or in parts, answers how its signal stood as it started, once the signal fires. */
async function waitingHost(options = {}) {
	const h = await controlledHost(options);
	const started = [];
	const handler = (_input, c) => {
		started.push(c.signal.aborted);
		return new Promise((resolve) => {
			const done = () => resolve({ outcome: "answered", answer: { aborted: true } });
			if (c.signal.aborted) done();
			else c.signal.addEventListener("abort", done, { once: true });
		});
	};
	await h.declare("wait", handler);
	await h.declare("wait-parts", handler, "parts");
	return { h, started };
}

// The host.

test("host: a cancel fires the invocation's signal, whole or in parts, and the operation's end follows", async () => {
	for (const operation of ["wait", "wait-parts"]) {
		const { h, started } = await waitingHost();
		const a = newAttempt();
		const served = watch(h.deliver(operation, requestOf(a, operation, {})));
		await turns();
		assert.deepEqual(started, [false]);
		await h.deliver(operation, controlOf("cancel", a, operation));
		await turns();
		assert.equal(served.settled, true, `${operation}: the operation, its signal fired, ended`);
		assert.deepEqual(h.sent("end", a.attempt)[0].payload.answer, { aborted: true });
	}
});

test("host: a cancel reaching the host while its evidence port is held leaves the signal fired as the operation starts, and asks nothing of the evidence port", async () => {
	const held = Promise.withResolvers();
	let asked = 0;
	const { h, started } = await waitingHost({ evidence: () => { asked++; return held.promise; } });
	const a = newAttempt();
	const served = watch(h.deliver("wait-parts", requestOf(a, "wait-parts", {}, 100)));
	await turns();
	await h.deliver("wait-parts", controlOf("cancel", a, "wait-parts"));
	held.resolve({ who: "caller" });
	await turns();
	assert.deepEqual(started, [true], "the signal fired as the operation started");
	assert.equal(asked, 1, "the evidence port asked of the request alone");
	assert.equal(served.settled, true);
});

test("host: a cancel or an alive from another node, naming another operation or invocation, under an attempt not recorded or finished, or with a field missing or added, is discarded unanswered, the evidence port not asked", async () => {
	let asked = 0;
	const { h, started } = await waitingHost({ evidence: () => { asked++; return null; } });
	const a = newAttempt();
	const served = watch(h.deliver("wait-parts", requestOf(a, "wait-parts", {}, 100_000)));
	await turns();
	const other = newAttempt();
	const finished = newAttempt();
	await h.host.declare({ name: "quick", input: { $schema: "urn:apnex:shape-check:dialect:1" }, answers: "whole" }, () => ({ outcome: "answered", answer: 1 }));
	await h.deliver("quick", requestOf(finished, "quick", {}));
	asked = 0;
	const sends = h.sends.length;
	for (const type of ["cancel", "alive"]) {
		const cases = [
			["from another node", "wait-parts", controlOf(type, a, "wait-parts"), { origin: "stranger" }],
			["naming another operation", "wait-parts", controlOf(type, a, "wait"), {}],
			["at another operation's endpoint", "wait", controlOf(type, a, "wait"), {}],
			["naming another invocation", "wait-parts", controlOf(type, a, "wait-parts", { invocation: other.invocation }), {}],
			["under another label", "wait-parts", controlOf(type, a, "wait-parts"), { label: other.attempt }],
			["under an attempt not recorded", "wait-parts", controlOf(type, other, "wait-parts"), {}],
			["under an attempt finished", "quick", controlOf(type, finished, "quick"), {}],
			["with a field missing", "wait-parts", controlOf(type, a, "wait-parts", { operation: undefined }), {}],
			["with a field added", "wait-parts", controlOf(type, a, "wait-parts", { extra: 1 }), {}],
		];
		for (const [what, endpoint, message, options] of cases) {
			await h.deliver(endpoint, message, options);
			await turns();
			assert.equal(served.settled, false, `a ${type} ${what} changes nothing`);
		}
	}
	assert.equal(h.sends.length, sends, "none answered");
	assert.equal(asked, 0, "the evidence port asked of none");
	assert.deepEqual(started, [false]);
	await h.deliver("wait-parts", controlOf("cancel", a, "wait-parts"));
	await turns();
	assert.equal(served.settled, true, "the cancel from the request's own node, as it is written, is taken");
});

// The caller.

/** A controlled call, its request admitted unless told otherwise. */
async function controlledCall({ bound = 100, parts = false, admit = true } = {}) {
	const t = await controlledCaller();
	const controller = new AbortController();
	const call = watch(t.caller.invoke({ host: "host-a", service: "svc", operation: "op", input: {}, bound, signal: controller.signal, ...(parts ? { onPart: () => undefined } : {}) }));
	await turns();
	if (admit) {
		t.sends[0].outcome.resolve({ messageId: "m1" });
		await turns();
	}
	const cancels = () => t.sends.filter((s) => s.payload.type === "cancel");
	return { t, controller, call, cancels };
}

test("caller: an abort after admission submits one cancel, pinned and labelled as the request, whole or in parts; the host's end then decides", async () => {
	for (const parts of [false, true]) {
		const { t, controller, call, cancels } = await controlledCall({ parts });
		t.clock.advance(10);
		controller.abort();
		await turns();
		assert.equal(cancels().length, 1, "one cancel");
		const sent = cancels()[0];
		assert.deepEqual(sent.payload, { operationCall: 1, type: "cancel", invocation: t.sends[0].payload.invocation, attempt: t.sends[0].payload.attempt, operation: "op" });
		assert.deepEqual([sent.source, sent.destination, sent.options.correlationId, sent.options.timeoutMs, sent.options.destinationSelector], ["operation-call/replies", "svc/op", t.sends[0].payload.attempt, 100, { originNodeId: "host-a", mode: "pinned" }]);
		assert.equal(call.settled, false, "the call waits for the host's end");
		await deliverTo(t, { type: "end", outcome: "answered", answer: "stopped", ...(parts ? { parts: 0 } : {}) });
		await turns();
		assert.deepEqual([call.value.ending, call.value.answer], ["answered", "stopped"]);
	}
});

test("caller: from an abort the deadline stands where it is: a cancelled call ends a bound after its last sign of life though the host keeps sending alive, and a later part is still given", async () => {
	const t = await controlledCaller();
	const controller = new AbortController();
	const parts = [];
	const call = watch(t.caller.invoke({ host: "host-a", service: "svc", operation: "op", input: {}, bound: 100, signal: controller.signal, onPart: (p) => { parts.push(p); } }));
	await turns();
	t.sends[0].outcome.resolve({ messageId: "m1" });
	t.clock.advance(40);
	await deliverTo(t, { type: "alive" });
	t.clock.advance(10);
	controller.abort();
	t.clock.advance(30);
	await deliverTo(t, { type: "alive" });
	await deliverTo(t, { type: "part", sequence: 1, answer: "late" });
	t.clock.advance(59);
	assert.equal(call.settled, false, "at 139 the call waits: its deadline stood at 140 when it was aborted");
	t.clock.advance(1);
	await turns();
	assert.deepEqual([call.value.ending, call.value.reason], ["unknown", "bound-passed"], "ended at 140, the alive and part after the abort moving nothing");
	assert.deepEqual(parts.map((p) => p.answer), ["late"], "the part after the abort still given to onPart");
	assert.equal(t.sends.filter((s) => s.payload.type === "cancel").length, 1, "one cancel, though the call then ended at its deadline");
});

test("caller: an abort between admission and its receipt submits the cancel when the receipt arrives; an abort before admission ends not delivered with ABORTED and submits nothing", async () => {
	const pending = await controlledCall({ admit: false });
	pending.controller.abort();
	await turns();
	assert.equal(pending.cancels().length, 0, "nothing submitted before the receipt");
	pending.t.sends[0].outcome.resolve({ messageId: "m1" });
	await turns();
	assert.equal(pending.cancels().length, 1, "the cancel goes once the receipt shows AGP admitted the request");
	const refused = await controlledCall({ admit: false });
	refused.controller.abort();
	refused.t.sends[0].outcome.reject(Object.assign(new Error("aborted"), { code: "ABORTED" }));
	await turns();
	assert.deepEqual([refused.call.value.ending, refused.call.value.agpCode], ["not-delivered", "ABORTED"]);
	assert.equal(refused.cancels().length, 0, "no cancel for a request AGP never admitted");
});

test("caller: an abort once the call has ended changes nothing", async () => {
	const { t, controller, call, cancels } = await controlledCall();
	await deliverTo(t, { type: "end", outcome: "answered", answer: 1 });
	await turns();
	assert.equal(call.value.ending, "answered");
	controller.abort();
	await turns();
	assert.equal(cancels().length, 0);
	assert.equal(call.count, 1);
});

test("caller: a call accepting parts that ends at its deadline or with part-missing submits one cancel, its admission observed only after the ending included; an abort followed by the deadline submits one", async () => {
	const atDeadline = await controlledCall({ parts: true });
	atDeadline.t.clock.advance(100);
	await turns();
	assert.equal(atDeadline.call.value.reason, "bound-passed");
	assert.equal(atDeadline.cancels().length, 1, "one cancel at the deadline");
	const missing = await controlledCall({ parts: true });
	await deliverTo(missing.t, { type: "part", sequence: 2, answer: 2 });
	await turns();
	assert.equal(missing.call.value.reason, "part-missing");
	assert.equal(missing.cancels().length, 1, "one cancel after part-missing");
	const late = await controlledCall({ parts: true, admit: false });
	late.t.clock.advance(100);
	await turns();
	assert.equal(late.call.value.reason, "bound-passed");
	assert.equal(late.cancels().length, 0, "none while the request's admission is unseen");
	late.t.sends[0].outcome.resolve({ messageId: "m1" });
	await turns();
	assert.equal(late.cancels().length, 1, "one once the receipt shows AGP admitted it, after the ending");
	const both = await controlledCall({ parts: true });
	both.controller.abort();
	both.t.clock.advance(100);
	await turns();
	assert.equal(both.call.value.reason, "bound-passed");
	assert.equal(both.cancels().length, 1, "an abort then the deadline: one cancel");
	const whole = await controlledCall();
	whole.t.clock.advance(100);
	await turns();
	assert.equal(whole.call.value.reason, "bound-passed");
	assert.equal(whole.cancels().length, 0, "a whole call ending at its bound submits no cancel");
});
