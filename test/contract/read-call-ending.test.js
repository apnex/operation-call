// read-call-ending - honest-call-ending: `readCallEnding` reads a candidate ending as plain data through
// shape-check's readPlainJson (zorg's D54, D55), running none of its code, and accepts exactly the fields of
// one of the four kinds of CallEnding - the call layer's direct endings, a hop's not-delivered and unknown
// endings, and the whole find's `bound-passed` ending with `attempt` null - with no single message's size or
// depth limit, giving it deeply frozen, or `{ok: false}`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCaller, readCallEnding } from "@apnex/operation-call";
import { createFakeNode } from "../support/fake-node.js";
import { createManualCallClock } from "../support/manual-call-clock.js";

const invocation = "1791540000000-3f9a0c1d2b4e5f60";
const attempt = `${invocation}.a1b2c3d4`;
const address = { invocation, attempt, operation: "update" };
const refusal = { part: "operation-call", code: "input-misfit", what: "w", why: "y", fix: "f", details: {}, misfits: [{ pointer: "", keyword: "type", expected: "object", fit: "a value of type object" }] };

const direct = {
	answered: { ending: "answered", ...address, answer: { position: 3, entity: null } },
	refused: { ending: "refused", ...address, refusal },
	notDelivered: { ending: "not-delivered", ...address, agpCode: "NO_ROUTE", proxyCode: null, earlierAttemptsUncertain: false },
	unknown: { ending: "unknown", ...address, reason: "bound-passed", agpCode: null, deliveryReport: "delivered" },
	failed: { ending: "unknown", ...address, reason: "answer-not-sendable", agpCode: "MESSAGE_TOO_LARGE", deliveryReport: null },
	operationFailed: { ending: "unknown", ...address, reason: "operation-failed", agpCode: null, deliveryReport: "unknown" },
};
const hop = {
	notDelivered: { ending: "not-delivered", ...address, attempt: null, agpCode: null, proxyCode: "proxy-unreachable", earlierAttemptsUncertain: true },
	lost: { ending: "unknown", ...address, attempt: null, reason: "proxy-lost", agpCode: null, deliveryReport: null },
	stalled: { ending: "unknown", ...address, attempt: null, reason: "hop-stalled", agpCode: null, deliveryReport: null },
	stalledAttempted: { ending: "unknown", ...address, reason: "hop-stalled", agpCode: null, deliveryReport: "delivered" },
};
const wholeFind = { ending: "unknown", ...address, attempt: null, reason: "bound-passed", agpCode: null, deliveryReport: null };

/** True when a value and every container in it are frozen, walked without recursion. */
function deeplyFrozen(value) {
	const stack = [value];
	while (stack.length > 0) {
		const item = stack.pop();
		if (item === null || typeof item !== "object") continue;
		if (!Object.isFrozen(item)) return false;
		for (const member of Object.values(item)) stack.push(member);
	}
	return true;
}

/** Asserts an ending is accepted whole, as a fresh deeply frozen copy. */
function accepted(ending, what) {
	const reading = readCallEnding(ending);
	assert.equal(reading.ok, true, what);
	assert.deepEqual(reading.ending, ending, what);
	assert.notEqual(reading.ending, ending, what);
	assert.ok(deeplyFrozen(reading.ending), what);
	assert.ok(Object.isFrozen(reading), what);
}

test("every direct ending of the call layer is accepted", () => {
	for (const [what, ending] of Object.entries(direct)) accepted(ending, what);
	accepted({ ...direct.notDelivered, earlierAttemptsUncertain: true }, "a repeat");
	accepted({ ...direct.answered, answer: null }, "a null answer");
	accepted({ ...direct.refused, refusal: { part: "p", code: "c", what: "w", why: "y", fix: "f", details: { k: 1 } } }, "a refusal without misfits");
});

test("a hop's endings, attempt null, and the whole find's bound-passed ending with attempt null are accepted", () => {
	for (const [what, ending] of Object.entries(hop)) accepted(ending, what);
	accepted(wholeFind, "the whole find's bound-passed");
});

test("an ending operation-call's own caller gives is accepted", async () => {
	const caller = await createCaller({ node: createFakeNode(), clock: createManualCallClock(0) });
	const ending = await caller.invoke({ host: "host-a", service: "svc", operation: "op", input: {}, bound: 100, repeat: true });
	assert.equal(ending.ending, "not-delivered");
	accepted(ending, "the caller's not-delivered ending");
});

test("a large multi-page answer is accepted, with no single message's size or depth limit", () => {
	const body = "x".repeat(262144);
	const entries = Array.from({ length: 70 }, (_, i) => ({ id: `e${i}`, body }));
	const answer = { position: 7, pages: [{ entries: entries.slice(0, 35) }, { entries: entries.slice(35) }] };
	let deep = 0;
	for (let i = 0; i < 100; i++) deep = [deep];
	const reading = readCallEnding({ ...direct.answered, answer: { ...answer, deep } });
	assert.equal(reading.ok, true);
	assert.equal(reading.ending.answer.pages[1].entries.length, 35);
	assert.equal(reading.ending.answer.pages[1].entries[34].body.length, 262144);
});

test("an ending with a field missing, extra, or of the wrong form is refused", () => {
	const refused = (ending, what) => assert.deepEqual(readCallEnding(ending), { ok: false }, what);
	for (const [kind, ending] of Object.entries({ ...direct, ...hop, wholeFind })) {
		for (const name of Object.keys(ending)) {
			const missing = { ...ending };
			delete missing[name];
			refused(missing, `${kind} without ${name}`);
		}
		refused({ ...ending, extra: 1 }, `${kind} with an extra key`);
		refused({ ...ending, invocation: "1791540000000-3F9A0C1D2B4E5F60" }, `${kind} with an invocation not as EM11 writes it`);
		refused({ ...ending, operation: "Update" }, `${kind} with an operation breaking EM1`);
	}
	refused({ ...direct.answered, ending: "done" }, "an unknown kind");
	refused({ ...direct.answered, attempt: "1791540000001-3f9a0c1d2b4e5f60.a1b2c3d4" }, "an attempt of another invocation");
	refused({ ...direct.answered, attempt: `${invocation}.A1B2C3D4` }, "an attempt not as EM11 writes it");
	refused({ ...direct.answered, attempt: null }, "an answered ending names its attempt");
	refused({ ...direct.refused, attempt: null }, "a refused ending names its attempt");
	refused({ ...direct.refused, refusal: { ...refusal, what: "" } }, "a refusal not in EM9's form");
	refused({ ...direct.notDelivered, agpCode: null }, "a direct not-delivered ending gives AGP's code");
	refused({ ...direct.notDelivered, agpCode: "" }, "an empty AGP code");
	refused({ ...direct.notDelivered, proxyCode: "proxy-unreachable" }, "a direct not-delivered ending names no proxy code");
	refused({ ...direct.notDelivered, earlierAttemptsUncertain: "no" }, "earlierAttemptsUncertain is a boolean");
	refused({ ...hop.notDelivered, agpCode: "NO_ROUTE" }, "a hop's not-delivered ending gives no AGP code");
	refused({ ...hop.notDelivered, proxyCode: null }, "a hop's not-delivered ending names its code");
	refused({ ...hop.notDelivered, proxyCode: "" }, "an empty proxy code");
	refused({ ...direct.unknown, reason: "run-failed" }, "a reason no caller gives");
	refused({ ...direct.unknown, deliveryReport: "failed" }, "a delivery report that ends a call");
	refused({ ...direct.unknown, agpCode: "" }, "an empty AGP code");
	refused({ ...wholeFind, reason: "operation-failed" }, "an unattempted unknown ending with a call layer's reason");
	refused({ ...wholeFind, reason: "answer-not-sendable" }, "an unattempted unknown ending with a call layer's reason");
	refused({ ...wholeFind, agpCode: "NO_ROUTE" }, "an unattempted unknown ending gives no AGP code");
	refused({ ...wholeFind, deliveryReport: "delivered" }, "an unattempted unknown ending gives no delivery report");
	for (const value of [null, undefined, "answered", 1, [direct.answered]]) refused(value, String(value));
});

test("an ending is read as plain data: getters never run, and custom prototypes, symbols and hidden fields are refused", () => {
	let calls = 0;
	const getter = { ...direct.answered };
	Object.defineProperty(getter, "answer", { get() { calls++; return 1; }, enumerable: true });
	assert.deepEqual(readCallEnding(getter), { ok: false });
	assert.deepEqual(readCallEnding({ ...direct.answered, answer: { get v() { calls++; return 1; } } }), { ok: false });
	assert.deepEqual(readCallEnding({ ...direct.refused, refusal: { ...refusal, get why() { calls++; return "y"; } } }), { ok: false });
	assert.equal(calls, 0);
	assert.deepEqual(readCallEnding(Object.assign(Object.create({ inherited: true }), direct.answered)), { ok: false });
	class Ending { constructor() { Object.assign(this, direct.notDelivered); } }
	assert.deepEqual(readCallEnding(new Ending()), { ok: false });
	assert.deepEqual(readCallEnding({ ...direct.answered, answer: new Date(0) }), { ok: false });
	assert.deepEqual(readCallEnding({ ...direct.answered, [Symbol("s")]: 1 }), { ok: false });
	const hidden = { ...direct.notDelivered };
	Object.defineProperty(hidden, "agpCode", { value: "NO_ROUTE", enumerable: false });
	assert.deepEqual(readCallEnding(hidden), { ok: false });
	assert.deepEqual(readCallEnding(new Proxy({ ...direct.answered }, { getOwnPropertyDescriptor() { throw new Error("trap"); } })), { ok: false });
	const thenData = { ...direct.answered, answer: {} };
	Object.defineProperty(thenData.answer, "then", { value: "data", enumerable: true });
	assert.equal(readCallEnding(thenData).ok, true, "an own data property named then is data");
});

test("an ending holding native promises is refused, with zero unhandled rejections", async () => {
	let unhandled = 0;
	const listener = () => { unhandled++; };
	process.on("unhandledRejection", listener);
	try {
		assert.deepEqual(readCallEnding(Promise.reject(new Error("whole"))), { ok: false });
		assert.deepEqual(readCallEnding({ ...direct.answered, answer: [Promise.reject(new Error("answer"))] }), { ok: false });
		assert.deepEqual(readCallEnding({ ...direct.refused, refusal: { ...refusal, details: { p: Promise.reject(new Error("refusal")) } } }), { ok: false });
		assert.deepEqual(readCallEnding({ ...direct.answered, then: Promise.reject(new Error("then")) }), { ok: false });
		for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 10));
	} finally {
		process.off("unhandledRejection", listener);
	}
	assert.equal(unhandled, 0);
});
