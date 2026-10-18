// peer-identity-evidence (carried from AGP) - the operation receives the delivery beneath's evidence of who
// is calling (zorg's target, EM13; zorg's D26, D31).
//
// The host asks the evidence function the host supplied - in zorg, caller-identity's answer - for each
// request as it arrives, before acting on it, giving it AGP's delivery context (the host reads and records a
// request first, which answer-in-parts.test.js and cancel-invocation.test.js observe, EM11); the
// operation receives that answer as its evidence, and AGP's delivery context as AGP gave it. Cases: the
// order of asking, for a request that runs, one that misfits and one that is malformed; the context and the
// answer unchanged; no function, giving null; a function that throws or whose promise rejects, ending the
// invocation failed with operation-failed and the operation never run; and a function answering asynchronously.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createOperationHost } from "@apnex/operation-call";
import { openTopology, until } from "../support/fixture.js";
import { ANY, ATTEMPT, INVOCATION, openRaw, request } from "../support/raw-requests.js";

const D = "urn:apnex:shape-check:dialect:1";

test("the host asks the evidence function for each request as it arrives, before judging its input, answering it malformed or running the operation", async (t) => {
	const events = [];
	const raw = await openRaw(t, {
		hostOptions: { evidence: (delivery) => { events.push(["evidence", delivery.messageId]); return { kind: "fixture", node: delivery.source.originNodeId }; } },
		declare: (host) => host.declare({ name: "op", input: { $schema: D, type: "integer" }, answers: "whole" }, (input, context) => { events.push(["handler", context.delivery.messageId]); return { outcome: "answered", answer: input }; }),
		endpoints: ["svc/op"],
	});
	const runs = await raw.send("svc/op", request("op", 1));
	const misfits = await raw.send("svc/op", request("op", "one"));
	const malformed = await raw.send("svc/op", request("op", 1, { extra: true }));
	await raw.repliesReach(3);
	assert.deepEqual(events, [["evidence", runs.messageId], ["handler", runs.messageId], ["evidence", misfits.messageId], ["evidence", malformed.messageId]]);
	assert.deepEqual(raw.replies.map((r) => r.payload.outcome), ["answered", "refused", "refused"]);
});

test("the operation receives the evidence function's answer unchanged and AGP's delivery context as AGP gave it", async (t) => {
	const topology = await openTopology();
	t.after(() => topology.close());
	const given = [];
	const answers = [];
	const { host } = await createOperationHost(topology.hosts[0].node, { service: "svc", evidence: (delivery) => {
		given.push(delivery);
		const answer = { kind: "agp-session", node: delivery.source.originNodeId, principal: null, proved: false };
		answers.push(answer);
		return answer;
	} });
	const seen = [];
	await host.declare({ name: "op", input: ANY, answers: "whole" }, (_input, context) => { seen.push(context); return { outcome: "answered", answer: null }; });
	await topology.hooks.ready("host-a", "svc/op");
	const ending = await topology.caller.invoke({ host: "host-a", service: "svc", operation: "op", input: {}, bound: 1000 });
	assert.equal(ending.ending, "answered");
	const [context] = seen;
	assert.deepEqual(context.evidence, answers[0], "the evidence function's answer as plain data");
	assert.ok(Object.isFrozen(context.evidence), "the evidence is deeply frozen");
	assert.equal(context.delivery, given[0], "the delivery context the evidence function was given");
	assert.equal(context.delivery.source.originNodeId, "caller");
	assert.equal(context.delivery.source.endpoint, "operation-call/replies");
	assert.equal(context.delivery.ingressNodeId, "caller");
	assert.equal(typeof context.delivery.ingressSessionId, "string");
	assert.equal(context.delivery.correlationId, ending.attempt);
	assert.equal(context.delivery.destination, "svc/op");
});

test("with no evidence function, the operation's evidence is null and it still receives AGP's delivery context", async (t) => {
	let context;
	const raw = await openRaw(t, { declare: (host) => host.declare({ name: "op", input: ANY, answers: "whole" }, (_i, c) => { context = c; return { outcome: "answered", answer: 1 }; }), endpoints: ["svc/op"] });
	await raw.send("svc/op", request("op"));
	await raw.repliesReach(1);
	assert.equal(context.evidence, null);
	assert.equal(context.delivery.source.originNodeId, "caller");
	assert.equal(context.delivery.correlationId, ATTEMPT);
});

test("an evidence function that throws ends the invocation failed with operation-failed, and the operation never runs", async (t) => {
	let ran = false;
	const raw = await openRaw(t, {
		hostOptions: { evidence: () => { throw new Error("no record"); } },
		declare: (host) => host.declare({ name: "op", input: ANY, answers: "whole" }, () => { ran = true; return { outcome: "answered", answer: 1 }; }),
		endpoints: ["svc/op"],
	});
	await raw.send("svc/op", request("op"));
	await raw.repliesReach(1);
	assert.deepEqual([raw.replies[0].payload.outcome, raw.replies[0].payload.reason, raw.replies[0].payload.agpCode], ["failed", "operation-failed", null]);
	assert.equal(ran, false);
});

test("an evidence function whose promise rejects likewise ends the invocation failed with operation-failed, and the operation never runs", async (t) => {
	let ran = false;
	const raw = await openRaw(t, {
		hostOptions: { evidence: async () => { throw new Error("no record"); } },
		declare: (host) => host.declare({ name: "op", input: ANY, answers: "whole" }, () => { ran = true; return { outcome: "answered", answer: 1 }; }),
		endpoints: ["svc/op"],
	});
	await raw.send("svc/op", request("op"));
	await raw.repliesReach(1);
	assert.deepEqual([raw.replies[0].payload.outcome, raw.replies[0].payload.reason, raw.replies[0].payload.agpCode], ["failed", "operation-failed", null]);
	assert.equal(ran, false);
});

test("an evidence function answering asynchronously is awaited before the operation runs", async (t) => {
	let release;
	const pending = new Promise((resolve) => { release = resolve; });
	let evidence;
	const raw = await openRaw(t, {
		hostOptions: { evidence: async () => { await pending; return { kind: "late" }; } },
		declare: (host) => host.declare({ name: "op", input: ANY, answers: "whole" }, (_i, c) => { evidence = c.evidence; return { outcome: "answered", answer: 1 }; }),
		endpoints: ["svc/op"],
	});
	await raw.send("svc/op", request("op"));
	for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
	assert.equal(evidence, undefined, "the operation waits for the evidence");
	release();
	await until(() => evidence !== undefined, "the operation runs");
	assert.deepEqual(evidence, { kind: "late" });
});

test("D2-E2, EM11, D54, D55: evidence is read as plain data after awaiting a native Promise only - a non-native thenable, getter, non-plain object, or nested rejected Promise ends operation-failed with zero getter calls and zero unhandled rejections without running the handler, while malformed-request still takes precedence", async (t) => {
	let getters = 0;
	let handlerRuns = 0;
	const cases = [
		() => ({ get kind() { getters++; return "x"; }, p: Promise.reject(new Error("evidence getter promise")) }),
		() => ({ then(resolve) { getters++; resolve({ kind: "x" }); }, p: Promise.reject(new Error("evidence thenable promise")) }),
		() => Object.create({ kind: "x" }),
		() => ({ kind: "x", p: Promise.reject(new Error("evidence nested promise")) }),
		() => Promise.resolve({ kind: "x", p: Promise.reject(new Error("async evidence nested promise")) }),
		() => Promise.reject(Object.assign(new Error("evidence rejected"), { p: Promise.reject(new Error("evidence rejected nested")) })),
		() => { throw Object.assign(new Error("evidence threw"), { p: Promise.reject(new Error("evidence thrown nested")) }); },
	];
	let idx = 0;
	const unhandled = [];
	const onUnhandled = (r) => unhandled.push(r);
	process.on("unhandledRejection", onUnhandled);
	try {
		const raw = await openRaw(t, {
			hostOptions: { evidence: () => cases[idx++ % cases.length]() },
			declare: (host) => host.declare({ name: "op", input: ANY, answers: "whole" }, () => { handlerRuns++; return { outcome: "answered", answer: 1 }; }),
			endpoints: ["svc/op"],
		});
		for (let i = 0; i < cases.length; i++) {
			const attempt = `${INVOCATION}.000005${String(i).padStart(2, "0")}`;
			await raw.send("svc/op", request("op", 1, { attempt }), attempt);
		}
		const malformedAttempt = `${INVOCATION}.00000599`;
		await raw.send("svc/op", request("op", 1, { attempt: malformedAttempt, extra: true }), malformedAttempt);
		await raw.repliesReach(cases.length + 1);
		for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
		for (const { payload } of raw.replies) {
			if (payload.attempt === malformedAttempt) assert.equal(payload.outcome, "refused");
			else assert.deepEqual([payload.outcome, payload.reason, payload.agpCode], ["failed", "operation-failed", null]);
		}
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
	assert.equal(handlerRuns, 0, "the operation handler never ran");
	assert.equal(getters, 0, "no getter or non-native thenable on evidence was called");
	assert.deepEqual(unhandled, [], "every rejected promise was observed");
});
