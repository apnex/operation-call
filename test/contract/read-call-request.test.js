// read-call-request - caller-chosen-bound: `readCallRequest` reads `host`, `service`, `operation`, `bound`,
// `invocation`, `repeat` and `signal` at most once each and snapshots `input` once through shape-check's
// snapshotJson, throwing EM12's RangeError or TypeError for a programming error and giving the checked request
// with the live abort signal; and the caller's `invoke` reads its clock first, then each field of the request
// once, so an accessor on the request or its input is read then and never again (zorg's EM12, D55).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCaller, readCallRequest } from "@apnex/operation-call";
import { createFakeNode } from "../support/fake-node.js";
import { createManualCallClock } from "../support/manual-call-clock.js";

const FIELDS = ["host", "service", "operation", "input", "bound", "invocation", "repeat", "signal", "onPart"];
const invocation = "1791540000000-3f9a0c1d2b4e5f60";
const base = () => ({ host: "host-a", service: "svc", operation: "op", input: { a: [1, -0] }, bound: 100 });

/** A call request whose every property read is logged, as an accessor on each field would be. */
function logged(call, log) {
	return new Proxy(call, { get(target, key, receiver) { log.push(String(key)); return Reflect.get(target, key, receiver); } });
}

test("a valid request is given back checked, its input snapshotted and frozen, its signal the live one", () => {
	const controller = new AbortController();
	const given = { ...base(), invocation, repeat: true, signal: controller.signal };
	const request = readCallRequest(given);
	assert.deepEqual({ ...request, signal: undefined }, { host: "host-a", service: "svc", operation: "op", input: { a: [1, 0] }, bound: 100, invocation, repeat: true, signal: undefined, onPart: undefined });
	assert.equal(request.signal, controller.signal, "the live AbortSignal, not a copy");
	assert.notEqual(request.input, given.input);
	assert.ok(Object.isFrozen(request.input) && Object.isFrozen(request.input.a));
	assert.ok(Object.is(request.input.a[1], 0));
	const plain = readCallRequest(base());
	assert.equal(plain.repeat, false);
	assert.equal(plain.invocation, undefined);
	assert.equal(plain.signal, undefined);
	assert.equal(readCallRequest({ ...base(), repeat: false }).repeat, false);
	assert.equal(readCallRequest({ ...base(), bound: 1 }).bound, 1);
	assert.equal(readCallRequest({ ...base(), bound: 2147483647 }).bound, 2147483647);
});

test("readCallRequest reads each field at most once, and the input's accessors once", () => {
	const log = [];
	let inputReads = 0;
	const input = { get v() { inputReads++; return [1]; } };
	readCallRequest(logged({ ...base(), input, invocation, repeat: false, signal: new AbortController().signal }, log));
	for (const field of FIELDS) assert.equal(log.filter((k) => k === field).length, 1, `${field} read once`);
	assert.deepEqual(log.filter((k) => !FIELDS.includes(k)), [], "nothing else read");
	assert.equal(inputReads, 1);
	const absent = [];
	readCallRequest(logged(base(), absent));
	for (const field of FIELDS) assert.ok(absent.filter((k) => k === field).length <= 1, `${field} read at most once`);
});

test("a programming error throws EM12's TypeError or RangeError", () => {
	for (const call of [null, undefined, 1, "call"]) assert.throws(() => readCallRequest(call), TypeError);
	for (const host of ["", 1, undefined, null]) assert.throws(() => readCallRequest({ ...base(), host }), TypeError, `host ${String(host)}`);
	for (const service of ["Svc", "", "-a", undefined, 1]) assert.throws(() => readCallRequest({ ...base(), service }), TypeError, `service ${String(service)}`);
	for (const operation of ["Op", "a/b", undefined]) assert.throws(() => readCallRequest({ ...base(), operation }), TypeError, `operation ${String(operation)}`);
	const cycle = {};
	cycle.self = cycle;
	for (const input of [undefined, NaN, [1, , 2], cycle, new Date(0), () => 1, 1n]) assert.throws(() => readCallRequest({ ...base(), input }), TypeError);
	const cause = new Error("getter");
	assert.throws(() => readCallRequest({ ...base(), input: { get v() { throw cause; } } }), (error) => error instanceof TypeError && error.cause === cause);
	for (const bound of [0, -1, 1.5, 2147483648, NaN, Infinity, "10", undefined, null]) assert.throws(() => readCallRequest({ ...base(), bound }), RangeError, `bound ${String(bound)}`);
	for (const bad of ["x", "1791540000000-3F9A0C1D2B4E5F60", 1, null]) assert.throws(() => readCallRequest({ ...base(), invocation: bad }), TypeError);
	for (const repeat of ["true", 1, null]) assert.throws(() => readCallRequest({ ...base(), repeat }), TypeError);
	for (const signal of [null, {}, { aborted: "no" }, 1]) assert.throws(() => readCallRequest({ ...base(), signal }), TypeError);
	assert.doesNotThrow(() => readCallRequest({ ...base(), signal: { aborted: false } }), "anything whose aborted is a boolean");
	for (const onPart of [null, 1, "f", {}]) assert.throws(() => readCallRequest({ ...base(), onPart }), TypeError, `onPart ${String(onPart)}`);
	const onPart = () => undefined;
	assert.equal(readCallRequest({ ...base(), onPart }).onPart, onPart, "the function given");
});

test("invoke reads its clock first, then each field of the request and the input's accessors once", async () => {
	const log = [];
	const manual = createManualCallClock(0);
	const clock = { now: () => { log.push("clock"); return manual.now(); }, schedule: (ms, callback) => manual.schedule(ms, callback) };
	const node = createFakeNode();
	const caller = await createCaller({ node, clock });
	const controller = new AbortController();
	const input = { get v() { log.push("input.v"); return 1; } };
	const call = logged({ host: "host-a", service: "svc", operation: "op", input, bound: 100, invocation, repeat: true, signal: controller.signal }, log);
	const ending = await caller.invoke(call);
	assert.equal(log[0], "clock", "the clock is read before anything of the request");
	for (const field of FIELDS) assert.equal(log.filter((k) => k === field).length, 1, `${field} read once`);
	assert.equal(log.filter((k) => k === "input.v").length, 1, "the input's accessor read once");
	assert.deepEqual(log.filter((k) => !FIELDS.includes(k) && k !== "clock" && k !== "input.v"), [], "nothing else of the request read");
	assert.deepEqual([ending.ending, ending.invocation, ending.earlierAttemptsUncertain], ["not-delivered", invocation, true]);
	const sent = node.sends[0];
	assert.equal(sent.destination, "svc/op");
	assert.equal(sent.options.signal, controller.signal, "the live signal passed to AGP");
	assert.deepEqual(sent.options.destinationSelector, { originNodeId: "host-a", mode: "pinned" });
	assert.deepEqual(sent.payload.input, { v: 1 });
});

test("invoke uses what each getter gave the first time: a bound, signal, invocation and repeat that change later change nothing", async () => {
	const manual = createManualCallClock(0);
	const order = [];
	const clock = { now: () => { order.push("clock"); return manual.now(); }, schedule: (ms, callback) => manual.schedule(ms, callback) };
	const node = createFakeNode();
	const caller = await createCaller({ node, clock });
	const controller = new AbortController();
	const reads = { bound: 0, signal: 0, invocation: 0, repeat: 0, input: 0 };
	const call = {
		host: "host-a", service: "svc", operation: "op",
		get input() { order.push("input"); return reads.input++ === 0 ? { first: true } : { later: true }; },
		get bound() { order.push("bound"); return reads.bound++ === 0 ? 50 : 0; },
		get signal() { order.push("signal"); return reads.signal++ === 0 ? controller.signal : null; },
		get invocation() { order.push("invocation"); return reads.invocation++ === 0 ? invocation : "bad"; },
		get repeat() { order.push("repeat"); return reads.repeat++ === 0 ? false : "bad"; },
	};
	const ending = await caller.invoke(call);
	assert.deepEqual(reads, { bound: 1, signal: 1, invocation: 1, repeat: 1, input: 1 });
	assert.equal(order[0], "clock", "the clock read first");
	assert.ok(order.indexOf("bound") > 0 && order.indexOf("signal") > 0 && order.indexOf("invocation") > 0 && order.indexOf("repeat") > 0 && order.indexOf("input") > 0);
	assert.deepEqual([ending.ending, ending.invocation, ending.earlierAttemptsUncertain], ["not-delivered", invocation, false]);
	assert.equal(node.sends[0].options.timeoutMs, 50, "the bound first read");
	assert.equal(node.sends[0].options.signal, controller.signal);
	assert.deepEqual(node.sends[0].payload.input, { first: true });
});
