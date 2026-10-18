// answer-in-parts - an answer may arrive as ordered parts; a missing part, or a stop before the end, ends the
// invocation as unknown, and parts already received stand (zorg's target, EM11, EM12; zorg's D64; Delta 4's
// D4-E4).
//
// The caller suite's cases for this row run directly against operation-call's own caller over AGP's
// production in-process carrier. Beside them, on a controlled host whose every send the test decides, with a
// manual clock: an operation answering in parts given `part`, its parts submitted one at a time in call order,
// each resolving true when admitted and false when refused, not plain JSON, nesting past AGP's depth, or called
// once the signal fired or the end was decided; parts sent to a request carrying no `aliveWithinMs`, whose end
// holds no `parts`; a refused part and a refused alive ending the invocation failed with answer-not-sendable,
// and an alive refused after the end changing nothing; the end waiting for the last submitted part, counting
// the admitted ones on every outcome, a malformed-request refusal holding none; the host's liveness and its
// alive, counted from the request's record, an alive read just before, at and after the liveness deadline with
// its timer held, the host's alive going on while the end waits; an alive reaching the host while the evidence
// port is held; and the host's record and timers gone once the last send settled, and on closing.
// And on a controlled caller node: `onPart` read once, the time its getter takes spent from the bound, and one
// not a function thrown; `aliveWithinMs` for bounds of 1, 2, 3 and 2147483647; the deadline moved by each part
// and alive, and one read just before, at and after it with its timer held; the caller's alive every
// `aliveWithinMs` whatever it took, one from a timer that woke late, and one AGP refuses changing nothing; a
// lower sequence discarded and counted, a higher one, and an end counting other than the parts taken, ending
// part-missing; an end lacking `parts` for a call accepting them, or holding `parts` for one that does not,
// discarded and counted; and a whole call's parts and alives discarded and counted.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readCallEnding } from "@apnex/operation-call";
import { registerCallerSuite } from "@apnex/operation-call/caller-suite";
import { controlledCaller, deliverTo, turns } from "../support/controlled-node.js";
import { controlOf, controlledHost, newAttempt, requestOf } from "../support/controlled-host.js";
import { directHarness } from "../support/fixture.js";

registerCallerSuite((name, run) => test(name, { timeout: 30_000 }, run), directHarness, ["answer-in-parts"]);

/** Watches a promise's settling. */
function watch(promise) {
	const w = { settled: false, value: undefined, count: 0 };
	promise.then((v) => { w.settled = true; w.value = v; w.count++; }, () => { w.settled = true; w.count++; });
	return w;
}

const endOf = (h, attempt) => h.sent("end", attempt).at(-1)?.payload;

// The host.

test("host: parts go one at a time in call order, each resolving true once admitted; the end waits for the last and counts them", async () => {
	const h = await controlledHost();
	const results = [];
	await h.declare("emit", async (input, c) => {
		const pending = input.items.map((item) => c.part(item));
		results.push(...(await Promise.all(pending)));
		return { outcome: "answered", answer: "done" };
	}, "parts");
	h.fate.decide = (s) => (s.payload.type === "part" ? "hold" : "admit");
	const a = newAttempt();
	const served = watch(h.deliver("emit", requestOf(a, "emit", { items: ["x", { y: 1 }, 3] }, 100)));
	await turns();
	assert.deepEqual(h.sent("part", a.attempt).length, 1, "the second part waits for the first to settle");
	for (let i = 0; i < 3; i++) {
		h.sent("part", a.attempt)[i].admit();
		await turns();
	}
	await turns();
	assert.deepEqual(h.sent("part", a.attempt).map((s) => [s.payload.sequence, s.payload.answer]), [[1, "x"], [2, { y: 1 }], [3, 3]]);
	for (const s of h.sent("part", a.attempt)) {
		assert.equal(s.destination, "operation-call/replies");
		assert.deepEqual([s.options.correlationId, s.options.destinationSelector], [a.attempt, { originNodeId: "caller", mode: "pinned" }], "pinned to the request's origin, labelled with its attempt");
	}
	assert.deepEqual(results, [true, true, true]);
	assert.equal(served.settled, true);
	assert.deepEqual(endOf(h, a.attempt), { operationCall: 1, type: "end", invocation: a.invocation, attempt: a.attempt, operation: "emit", outcome: "answered", answer: "done", parts: 3 });
});

test("host: part resolves false, sending nothing, for an answer that is not plain JSON or nests past AGP's depth, and selects answer-not-sendable with no AGP code", async () => {
	let deep = "core";
	for (let i = 0; i < 30; i++) deep = [deep];
	for (const [what, bad] of [["a function", () => 1], ["a Map", new Map()], ["an answer 30 levels deep, past the message's 30", deep]]) {
		const h = await controlledHost();
		let result;
		let after;
		await h.declare("emit", async (_input, c) => {
			result = await c.part(bad);
			after = await c.part("later");
			return { outcome: "answered", answer: "ignored" };
		}, "parts");
		const a = newAttempt();
		await h.deliver("emit", requestOf(a, "emit", {}, 100));
		assert.deepEqual([result, after], [false, false], `${what}: false, and the part after it false`);
		assert.equal(h.sent("part", a.attempt).length, 0, `${what}: no part sent`);
		assert.deepEqual(endOf(h, a.attempt), { operationCall: 1, type: "end", invocation: a.invocation, attempt: a.attempt, operation: "emit", outcome: "failed", reason: "answer-not-sendable", agpCode: null, parts: 0 }, what);
	}
});

test("host: a refused part ends the invocation failed with answer-not-sendable and AGP's code, its signal fired, later parts unsent and the operation's later answer discarded", async () => {
	const h = await controlledHost();
	let signal;
	const results = [];
	const released = Promise.withResolvers();
	await h.declare("emit", async (_input, c) => {
		signal = c.signal;
		results.push(await c.part("one"), await c.part("two"), await c.part("three"));
		await released.promise;
		return { outcome: "answered", answer: "too late" };
	}, "parts");
	h.fate.decide = (s) => (s.payload.type === "part" && s.payload.sequence === 2 ? { reject: "MESSAGE_TOO_LARGE" } : "admit");
	const a = newAttempt();
	const served = watch(h.deliver("emit", requestOf(a, "emit", {}, 100)));
	await turns();
	assert.deepEqual(results, [true, false, false], "the refused part false, the one after it false");
	assert.equal(h.sent("part", a.attempt).length, 2, "the third part never sent");
	assert.equal(signal.aborted, true, "the invocation's signal fired");
	assert.equal(served.settled, true, "the failed end sent without waiting for the operation");
	assert.deepEqual(endOf(h, a.attempt), { operationCall: 1, type: "end", invocation: a.invocation, attempt: a.attempt, operation: "emit", outcome: "failed", reason: "answer-not-sendable", agpCode: "MESSAGE_TOO_LARGE", parts: 1 });
	released.resolve();
	await turns();
	assert.equal(h.sent("end", a.attempt).length, 1, "the operation's later answer discarded");
});

test("host: a cancel, and in turn an end decided, while one part's admission is held and another waits: the waiting part resolves false unsent, the held one as AGP decides, and the end waits for it and counts it", async () => {
	for (const how of ["cancel", "end"]) {
		const h = await controlledHost();
		const results = {};
		await h.declare("emit", async (_input, c) => {
			const first = c.part("held").then((r) => { results.held = r; });
			const second = c.part("waiting").then((r) => { results.waiting = r; });
			if (how === "cancel") await new Promise((resolve) => c.signal.addEventListener("abort", resolve, { once: true }));
			void first;
			void second;
			return { outcome: "answered", answer: how };
		}, "parts");
		h.fate.decide = (s) => (s.payload.type === "part" ? "hold" : "admit");
		const a = newAttempt();
		const served = watch(h.deliver("emit", requestOf(a, "emit", {}, 100)));
		await turns();
		if (how === "cancel") await h.deliver("emit", controlOf("cancel", a, "emit"));
		await turns();
		if (how === "end") assert.equal(results.waiting, false, "end: the waiting part resolves false once the end is decided");
		assert.equal(results.waiting, false, `${how}: the waiting part resolves false`);
		assert.equal(h.sent("part", a.attempt).length, 1, `${how}: the waiting part is never sent`);
		assert.equal(served.settled, false, `${how}: the end waits for the held part`);
		assert.equal(h.sent("end", a.attempt).length, 0);
		h.sent("part", a.attempt)[0].admit();
		await turns();
		assert.equal(results.held, true, `${how}: the held part resolves as AGP decided`);
		assert.deepEqual([endOf(h, a.attempt)?.outcome, endOf(h, a.attempt)?.parts], ["answered", 1], `${how}: the end counts the admitted part`);
	}
});

test("host: parts are sent to a request carrying no aliveWithinMs, whose end holds no parts; part after the end resolves false", async () => {
	const h = await controlledHost();
	let kept;
	await h.declare("emit", async (_input, c) => {
		kept = c.part;
		assert.equal(await c.part("one"), true);
		return { outcome: "answered", answer: "done" };
	}, "parts");
	const a = newAttempt();
	await h.deliver("emit", requestOf(a, "emit", {}));
	assert.equal(h.sent("part", a.attempt).length, 1, "the part sent, for its caller to discard");
	assert.deepEqual(endOf(h, a.attempt), { operationCall: 1, type: "end", invocation: a.invocation, attempt: a.attempt, operation: "emit", outcome: "answered", answer: "done" });
	assert.equal(await kept("after"), false, "a part called once the end was decided");
	assert.equal(h.sent("part", a.attempt).length, 1);
});

test("host: every end answering a request with aliveWithinMs holds parts, whatever its outcome; a malformed-request refusal holds none", async () => {
	const failing = await controlledHost({ evidence: () => { throw new Error("no evidence"); } });
	await failing.declare("emit", () => ({ outcome: "answered", answer: 1 }), "parts");
	const e = newAttempt();
	await failing.deliver("emit", requestOf(e, "emit", {}, 50));
	assert.deepEqual([endOf(failing, e.attempt).reason, endOf(failing, e.attempt).parts], ["operation-failed", 0], "evidence failure");
	const h = await controlledHost();
	const REFUSAL = { part: "x", code: "no", what: "w", why: "y", fix: "f", details: {} };
	await h.declare("refuses", () => ({ outcome: "refused", refusal: REFUSAL }), "parts");
	await h.declare("throws", () => { throw new Error("fails"); }, "parts");
	await h.host.declare({ name: "strict", input: { $schema: "urn:apnex:shape-check:dialect:1", type: "integer" }, answers: "parts" }, () => ({ outcome: "answered", answer: 1 }));
	for (const [operation, outcome] of [["refuses", "refused"], ["throws", "failed"], ["strict", "refused"]]) {
		const a = newAttempt();
		await h.deliver(operation, requestOf(a, operation, {}, 50));
		assert.deepEqual([endOf(h, a.attempt).outcome, endOf(h, a.attempt).parts], [outcome, 0], operation);
	}
	const m = newAttempt();
	await h.deliver("refuses", { ...requestOf(m, "refuses", {}, 50), extra: 1 });
	const refusal = endOf(h, m.attempt);
	assert.equal(refusal.refusal.code, "malformed-request");
	assert.equal(Object.hasOwn(refusal, "parts"), false, "a malformed-request refusal holds no parts");
	const big = newAttempt();
	await h.deliver("refuses", requestOf(big, "refuses", {}, 1073741824));
	assert.equal(endOf(h, big.attempt).refusal.code, "malformed-request", "an aliveWithinMs past 1073741823 breaks the request's form");
});

test("host: the host's alive goes every aliveWithinMs without a part, from the record, one from a timer that woke late, and none for a request without aliveWithinMs or once the signal fired", async () => {
	const h = await controlledHost();
	await h.declare("quiet", (_input, c) => new Promise((resolve) => c.signal.addEventListener("abort", () => resolve({ outcome: "answered", answer: "stopped" }), { once: true })), "parts");
	const a = newAttempt();
	const served = watch(h.deliver("quiet", requestOf(a, "quiet", {}, 100)));
	await turns();
	h.clock.advance(99);
	assert.equal(h.sent("alive", a.attempt).length, 0, "none before aliveWithinMs");
	h.clock.advance(1);
	assert.equal(h.sent("alive", a.attempt).length, 1, "one at aliveWithinMs");
	await h.deliver("quiet", controlOf("alive", a, "quiet"));
	h.clock.advance(100);
	assert.equal(h.sent("alive", a.attempt).length, 2, "another a further aliveWithinMs on");
	const sent = h.sent("alive", a.attempt)[0];
	assert.deepEqual(sent.payload, { operationCall: 1, type: "alive", invocation: a.invocation, attempt: a.attempt, operation: "quiet" });
	assert.deepEqual([sent.source, sent.destination, sent.options.correlationId, sent.options.destinationSelector], ["svc/quiet", "operation-call/replies", a.attempt, { originNodeId: "caller", mode: "pinned" }]);
	// Its timer held while the caller's alives keep the invocation, the host's next alive falls 200 ms late.
	await h.deliver("quiet", controlOf("alive", a, "quiet"));
	h.clock.move(150);
	await h.deliver("quiet", controlOf("alive", a, "quiet"));
	h.clock.move(150);
	await h.deliver("quiet", controlOf("alive", a, "quiet"));
	h.clock.advance(0);
	assert.equal(h.sent("alive", a.attempt).length, 3, "a timer waking two intervals late submits one, not three");
	h.clock.advance(99);
	assert.equal(h.sent("alive", a.attempt).length, 3, "the next counted on from the late one");
	await h.deliver("quiet", controlOf("alive", a, "quiet"));
	h.clock.advance(1);
	assert.equal(h.sent("alive", a.attempt).length, 4, "and goes aliveWithinMs after it");
	await h.deliver("quiet", controlOf("cancel", a, "quiet"));
	await turns();
	h.clock.advance(1000);
	assert.equal(h.sent("alive", a.attempt).length, 4, "none once the signal fired");
	assert.equal(served.settled, true);
	const one = newAttempt();
	const fast = watch(h.deliver("quiet", requestOf(one, "quiet", {}, 1)));
	await turns();
	h.clock.advance(1);
	assert.equal(h.sent("alive", one.attempt).length, 1, "at 1 ms for an aliveWithinMs of 1");
	await h.deliver("quiet", controlOf("cancel", one, "quiet"));
	await turns();
	assert.equal(fast.settled, true);
	const none = newAttempt();
	const plain = watch(h.deliver("quiet", requestOf(none, "quiet", {})));
	await turns();
	h.clock.advance(10_000);
	assert.equal(h.sent("alive", none.attempt).length, 0, "none for a request without aliveWithinMs");
	await h.deliver("quiet", controlOf("cancel", none, "quiet"));
	await turns();
	assert.equal(plain.settled, true);
});

test("host: the host's alive goes on while the end waits for a held part; one refused then changes nothing, and one refused before the end ends the invocation failed", async () => {
	const h = await controlledHost();
	await h.declare("emit", (_input, c) => {
		void c.part("held");
		return { outcome: "answered", answer: "done" };
	}, "parts");
	h.fate.decide = (s) => (s.payload.type === "part" ? "hold" : s.payload.type === "alive" ? { reject: "NO_ROUTE" } : "admit");
	const a = newAttempt();
	const served = watch(h.deliver("emit", requestOf(a, "emit", {}, 100)));
	await turns();
	h.clock.advance(100);
	await turns();
	assert.equal(h.sent("alive", a.attempt).length, 1, "an alive while the end waits");
	h.sent("part", a.attempt)[0].admit();
	await turns();
	assert.equal(served.settled, true);
	assert.deepEqual([endOf(h, a.attempt).outcome, endOf(h, a.attempt).parts], ["answered", 1], "the alive refused after the end was decided changes nothing");
	const q = await controlledHost();
	await q.declare("quiet", (_input, c) => new Promise((resolve) => c.signal.addEventListener("abort", () => resolve({ outcome: "answered", answer: "stopped" }), { once: true })), "parts");
	q.fate.decide = (s) => (s.payload.type === "alive" ? { reject: "NO_ROUTE" } : "admit");
	const b = newAttempt();
	await (async () => {
		const pending = q.deliver("quiet", requestOf(b, "quiet", {}, 100));
		await turns();
		q.clock.advance(100);
		await pending;
	})();
	assert.deepEqual(endOf(q, b.attempt), { operationCall: 1, type: "end", invocation: b.invocation, attempt: b.attempt, operation: "quiet", outcome: "failed", reason: "answer-not-sendable", agpCode: "NO_ROUTE", parts: 0 });
});

test("host: the liveness deadline is twice aliveWithinMs from the record, moved by each caller's alive; an alive read just before it is taken, and at or after it is not and the signal fires for good", async () => {
	for (const [what, at, taken] of [["just before", 199, true], ["exactly at", 200, false], ["after", 250, false]]) {
		const h = await controlledHost();
		let signal;
		await h.declare("quiet", (_input, c) => {
			signal = c.signal;
			return new Promise((resolve) => c.signal.addEventListener("abort", () => resolve({ outcome: "answered", answer: "stopped" }), { once: true }));
		}, "parts");
		const a = newAttempt();
		const served = watch(h.deliver("quiet", requestOf(a, "quiet", {}, 100)));
		await turns();
		h.clock.move(at);
		await h.deliver("quiet", controlOf("alive", a, "quiet"));
		await turns();
		assert.equal(signal.aborted, !taken, `an alive ${what} the deadline, its timer held: ${taken ? "taken" : "not taken, the signal fired"}`);
		if (taken) {
			h.clock.advance(0);
			h.clock.advance(199);
			assert.equal(signal.aborted, false, "the deadline moved to twice aliveWithinMs after the alive, 399");
			h.clock.advance(1);
			await turns();
			assert.equal(signal.aborted, true, "and fires there");
		} else {
			await h.deliver("quiet", controlOf("alive", a, "quiet"));
			assert.equal(signal.aborted, true, "an expired liveness is never revived");
		}
		await turns();
		assert.equal(served.settled, true);
	}
});

test("host: a caller's alive reaching the host while its evidence port is held keeps the liveness deadline", async () => {
	const held = Promise.withResolvers();
	let asked = 0;
	const h = await controlledHost({ evidence: () => { asked++; return held.promise; } });
	let started;
	await h.declare("quiet", (_input, c) => {
		started = c.signal.aborted;
		return new Promise((resolve) => c.signal.addEventListener("abort", () => resolve({ outcome: "answered", answer: "stopped" }), { once: true }));
	}, "parts");
	const a = newAttempt();
	const served = watch(h.deliver("quiet", requestOf(a, "quiet", {}, 100)));
	await turns();
	h.clock.advance(150);
	await h.deliver("quiet", controlOf("alive", a, "quiet"));
	h.clock.advance(150);
	held.resolve({ who: "caller" });
	await turns();
	assert.equal(started, false, "at 300 the invocation lives: the alive at 150, while the evidence port was held, moved its deadline to 350");
	assert.equal(asked, 1, "the evidence port asked of the request alone");
	h.clock.advance(50);
	await turns();
	assert.equal(served.settled, true, "the deadline at 350 fired the signal");
});

test("host: the record and every timer go once the last send settled, a refused end included, across many requests, and on closing", async () => {
	const h = await controlledHost();
	await h.declare("emit", async (_input, c) => {
		await c.part("one");
		return { outcome: "answered", answer: "done" };
	}, "parts");
	await h.declare("quiet", (_input, c) => new Promise((resolve) => c.signal.addEventListener("abort", () => resolve({ outcome: "answered", answer: "stopped" }), { once: true })), "parts");
	h.fate.decide = (s) => (s.payload.type === "end" ? { reject: "NO_ROUTE" } : "admit");
	const attempts = [];
	for (let i = 0; i < 40; i++) {
		const a = newAttempt();
		attempts.push(a);
		await h.deliver("emit", requestOf(a, "emit", {}, 100));
	}
	assert.equal(h.clock.pending(), 0, "no timer left after 40 requests whose ends AGP refused");
	const before = h.sends.length;
	await h.deliver("emit", controlOf("cancel", attempts[0], "emit"));
	await h.deliver("emit", controlOf("alive", attempts[0], "emit"));
	h.clock.advance(1000);
	assert.equal(h.sends.length, before, "a finished request takes no cancel or alive, and sends nothing more");
	const open = newAttempt();
	void h.deliver("quiet", requestOf(open, "quiet", {}, 100));
	await turns();
	assert.ok(h.clock.pending() > 0, "a request in flight keeps its timers");
	await h.host.close();
	assert.equal(h.clock.pending(), 0, "closing finishes every request");
});

// The caller.

test("caller: onPart is read once with the other fields, its getter's time spent from the bound; one that is not a function is thrown, nothing sent", async () => {
	const t = await controlledCaller();
	let reads = 0;
	const request = { host: "host-a", service: "svc", operation: "op", input: {}, bound: 100, get onPart() { reads++; t.clock.move(30); return () => undefined; } };
	void t.caller.invoke(request);
	await turns();
	assert.equal(reads, 1, "onPart read once");
	assert.equal(t.sends[0].options.timeoutMs, 70, "the 30 ms its getter took spent from the bound");
	for (const onPart of [null, 1, {}, "f"]) await assert.rejects(t.caller.invoke({ host: "host-a", service: "svc", operation: "op", input: {}, bound: 100, onPart }), TypeError);
	assert.equal(t.sends.length, 1, "nothing sent for a call whose onPart is not a function");
});

test("caller: a call accepting parts carries aliveWithinMs, the greater of 1 and half its bound rounded down; one accepting none carries none", async () => {
	for (const [bound, alive] of [[1, 1], [2, 1], [3, 1], [1001, 500], [2147483647, 1073741823]]) {
		const t = await controlledCaller();
		void t.caller.invoke({ host: "host-a", service: "svc", operation: "op", input: {}, bound, onPart: () => undefined });
		await turns();
		assert.equal(t.sends[0].payload.aliveWithinMs, alive, `a bound of ${bound}`);
		assert.deepEqual(Object.keys(t.sends[0].payload), ["operationCall", "type", "invocation", "attempt", "operation", "input", "aliveWithinMs"]);
	}
	const t = await controlledCaller();
	void t.caller.invoke({ host: "host-a", service: "svc", operation: "op", input: {}, bound: 100 });
	await turns();
	assert.equal(Object.hasOwn(t.sends[0].payload, "aliveWithinMs"), false);
});

/** A controlled call accepting parts, its request admitted, collecting what onPart is given. */
async function partsCall(bound = 100) {
	const t = await controlledCaller();
	const parts = [];
	const call = watch(t.caller.invoke({ host: "host-a", service: "svc", operation: "op", input: {}, bound, onPart: (p) => { parts.push(p); } }));
	await turns();
	t.sends[0].outcome.resolve({ messageId: "m1" });
	await turns();
	return { t, call, parts };
}

test("caller: each part and alive taken before the deadline moves it a bound on; one read just before it is taken, and at or after it is not, the call ending at its bound", async () => {
	const { t, call } = await partsCall();
	t.clock.advance(60);
	await deliverTo(t, { type: "alive" });
	t.clock.advance(99);
	assert.equal(call.settled, false, "at 159 the alive at 60 holds the call");
	await deliverTo(t, { type: "part", sequence: 1, answer: "one" });
	t.clock.advance(99);
	assert.equal(call.settled, false, "at 258 the part at 159 holds it");
	t.clock.advance(1);
	await turns();
	assert.deepEqual([call.value.ending, call.value.reason], ["unknown", "bound-passed"]);
	for (const [what, at, taken] of [["just before", 99, true], ["exactly at", 100, false], ["after", 130, false]]) {
		for (const type of ["part", "alive"]) {
			const p = await partsCall();
			p.t.clock.move(at);
			await deliverTo(p.t, type === "part" ? { type, sequence: 1, answer: 1 } : { type });
			await turns();
			if (taken) {
				assert.equal(p.call.settled, false, `a ${type} ${what} the deadline is taken`);
				assert.equal(p.parts.length, type === "part" ? 1 : 0);
				p.t.clock.advance(0);
				p.t.clock.advance(99);
				assert.equal(p.call.settled, false, `and moved the deadline to ${at + 100}`);
			} else {
				assert.deepEqual([p.call.value?.ending, p.call.value?.reason], ["unknown", "bound-passed"], `a ${type} ${what} the deadline, its timer held, loses to it`);
				assert.equal(p.parts.length, 0, "and is not given to onPart");
			}
		}
	}
});

test("caller: the caller submits an alive each aliveWithinMs since its request or its last alive, whatever it took, one from a timer that woke late; one AGP refuses changes nothing", async () => {
	const { t, call } = await partsCall(100);
	const alives = () => t.sends.filter((s) => s.payload.type === "alive");
	t.clock.advance(49);
	assert.equal(alives().length, 0);
	t.clock.advance(1);
	assert.equal(alives().length, 1, "at aliveWithinMs");
	const sent = alives()[0];
	assert.deepEqual(sent.payload, { operationCall: 1, type: "alive", invocation: t.sends[0].payload.invocation, attempt: t.sends[0].payload.attempt, operation: "op" });
	assert.deepEqual([sent.source, sent.destination, sent.options.correlationId, sent.options.timeoutMs, sent.options.destinationSelector], ["operation-call/replies", "svc/op", t.sends[0].payload.attempt, 50, { originNodeId: "host-a", mode: "pinned" }]);
	sent.outcome.reject(Object.assign(new Error("refused"), { code: "NO_ROUTE" }));
	t.clock.advance(10);
	await deliverTo(t, { type: "alive" });
	t.clock.advance(40);
	assert.equal(alives().length, 2, "the next at 100, counted from its own last alive, whatever it took at 60");
	await turns();
	assert.equal(call.settled, false, "an alive AGP refused changed nothing");
	// Its timer held while the host's alives keep the call, the caller's next alive falls 110 ms late.
	await deliverTo(t, { type: "alive" });
	t.clock.move(90);
	await deliverTo(t, { type: "alive" });
	t.clock.move(70);
	t.clock.advance(0);
	assert.equal(alives().length, 3, "a timer waking over two intervals late submits one, not three");
	await deliverTo(t, { type: "alive" });
	t.clock.advance(49);
	assert.equal(alives().length, 3, "the next counted on from the late one");
	t.clock.advance(1);
	assert.equal(alives().length, 4);
	assert.equal(call.settled, false);
});

test("caller: a lower sequence is discarded and counted; a higher one, or an end counting other than the parts taken, ends part-missing with the last delivery report, the parts taken standing", async () => {
	const lower = await partsCall();
	await deliverTo(lower.t, { type: "part", sequence: 1, answer: "one" });
	const discarded = lower.t.caller.discarded();
	await deliverTo(lower.t, { type: "part", sequence: 1, answer: "again" });
	assert.equal(lower.t.caller.discarded(), discarded + 1, "a lower sequence counted");
	await deliverTo(lower.t, { type: "end", outcome: "answered", answer: "done", parts: 1 });
	await turns();
	assert.deepEqual([lower.call.value.ending, lower.call.value.answer], ["answered", "done"]);
	assert.deepEqual(lower.parts.map((p) => p.answer), ["one"]);
	for (const [what, messages] of [
		["a higher sequence", [{ type: "part", sequence: 1, answer: 1 }, { type: "part", sequence: 3, answer: 3 }]],
		["an end counting more", [{ type: "part", sequence: 1, answer: 1 }, { type: "end", outcome: "answered", answer: 1, parts: 2 }]],
		["an end counting fewer", [{ type: "part", sequence: 1, answer: 1 }, { type: "end", outcome: "refused", refusal: { part: "x", code: "c", what: "w", why: "y", fix: "f", details: {} }, parts: 0 }]],
	]) {
		const p = await partsCall();
		for (const m of messages) await deliverTo(p.t, m);
		await turns();
		const ending = p.call.value;
		assert.deepEqual(ending, { ending: "unknown", invocation: ending.invocation, attempt: ending.attempt, operation: "op", reason: "part-missing", agpCode: null, deliveryReport: null }, what);
		assert.ok(Object.isFrozen(ending));
		assert.deepEqual(p.parts.map((x) => x.sequence), [1], `${what}: the part taken stands`);
		assert.equal(readCallEnding(ending).ok, true, `${what}: readCallEnding accepts a part-missing ending`);
	}
});

test("caller: an end lacking parts for a call accepting them, or holding parts for one that does not, is discarded and counted; a whole call's parts and alives too", async () => {
	const p = await partsCall();
	let discarded = p.t.caller.discarded();
	await deliverTo(p.t, { type: "end", outcome: "answered", answer: "done" });
	assert.equal(p.t.caller.discarded(), discarded + 1);
	assert.equal(p.call.settled, false, "an end holding no parts is not taken by a call accepting parts");
	const t = await controlledCaller();
	const call = watch(t.caller.invoke({ host: "host-a", service: "svc", operation: "op", input: {}, bound: 100 }));
	await turns();
	t.sends[0].outcome.resolve({ messageId: "m1" });
	discarded = t.caller.discarded();
	await deliverTo(t, { type: "part", sequence: 1, answer: 1 });
	await deliverTo(t, { type: "alive" });
	await deliverTo(t, { type: "end", outcome: "answered", answer: "done", parts: 0 });
	await deliverTo(t, { type: "cancel" });
	await deliverTo(t, { type: "request", input: {} });
	assert.equal(t.caller.discarded(), discarded + 5, "a part, an alive, a counted end, a cancel and a request, each discarded and counted");
	assert.equal(call.settled, false);
	await deliverTo(t, { type: "end", outcome: "answered", answer: "done" });
	await turns();
	assert.deepEqual([call.value.ending, call.value.answer], ["answered", "done"], "the end holding no parts decides a whole call");
	const whole = await partsCall();
	await deliverTo(whole.t, { type: "end", outcome: "answered", answer: "whole", parts: 0 });
	await turns();
	assert.deepEqual([whole.call.value.ending, whole.call.value.answer], ["answered", "whole"], "a whole operation's end counting no part decides a call accepting parts");
});

test("message format: a request carries aliveWithinMs from 1 to 1073741823, an end parts from 0, and alive and cancel exactly their address", async () => {
	const { readMessage, writeAlive, writeCancel, writeEnd, writeRequest, MESSAGE_LIMITS } = await import("@apnex/operation-call/message-format");
	const a = newAttempt();
	const address = { invocation: a.invocation, attempt: a.attempt, operation: "op" };
	assert.equal(MESSAGE_LIMITS.aliveWithinMs, 1073741823);
	for (const alive of [1, 1073741823]) assert.deepEqual(readMessage(writeRequest(address, {}, alive)), writeRequest(address, {}, alive));
	for (const alive of [0, 1073741824, 1.5, "1", null]) assert.equal(readMessage({ ...writeRequest(address, {}), aliveWithinMs: alive }), undefined, `aliveWithinMs ${String(alive)}`);
	assert.deepEqual(Object.keys(writeEnd(address, { outcome: "answered", answer: 1 }, 2)), ["operationCall", "type", "invocation", "attempt", "operation", "outcome", "answer", "parts"]);
	for (const parts of [0, 9007199254740991]) assert.notEqual(readMessage(writeEnd(address, { outcome: "failed", reason: "answer-not-sendable", agpCode: null }, parts)), undefined);
	for (const parts of [-1, 1.5, "2", null]) assert.equal(readMessage({ ...writeEnd(address, { outcome: "answered", answer: 1 }), parts }), undefined, `parts ${String(parts)}`);
	for (const write of [writeAlive, writeCancel]) {
		const message = write(address);
		assert.deepEqual(Object.keys(message), ["operationCall", "type", "invocation", "attempt", "operation"]);
		assert.deepEqual(readMessage(message), message);
		assert.equal(readMessage({ ...message, extra: 1 }), undefined);
	}
});
