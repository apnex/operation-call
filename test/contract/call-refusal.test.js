// call-refusal - when an operation refuses an invocation, the caller receives what was wrong, why, and how
// to fix it, in the shared refusal form, carrying any reason another component supplied unchanged (zorg's
// target, EM9, EM11; zorg's D21; zorg's E5, E6).
//
// The caller suite's cases for this row run directly against operation-call's own caller: an operation's
// refusal, another part's reason and misfits included, unchanged; input that misfits refused before the
// operation runs; requests of 30, 31 and 4000 levels; integers at and beyond the safe range; and request
// messages of 16777216 bytes and one more, beside other calls. Beside them, on the host: operation-call's
// own records have exactly EM9's fields; a malformed request is refused as malformed-request when its label
// is an attempt identity, and discarded otherwise; an operation's refusal not in EM9's form is a failure,
// never a refusal; and a refusal too large to cross AGP ends the call unknown with AGP's code.
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerCallerSuite } from "@apnex/operation-call/caller-suite";
import { directHarness, openTopology, turn } from "../support/fixture.js";
import { ANY, ATTEMPT, INVOCATION, openRaw, request } from "../support/raw-requests.js";

registerCallerSuite((name, run) => test(name, { timeout: 30_000 }, run), directHarness, ["call-refusal"]);

const EM9_FIELDS = ["code", "details", "fix", "part", "what", "why"];
const end = (outcome, rest, attempt = ATTEMPT, operation = "op") => ({ operationCall: 1, type: "end", invocation: attempt.slice(0, attempt.indexOf(".")), attempt, operation, outcome, ...rest });

test("operation-call's own refusals have exactly EM9's fields, part operation-call, no details, and misfits only for input-misfit", async (t) => {
	const shape = { $schema: ANY.$schema, type: "string" };
	const raw = await openRaw(t, { declare: (host) => host.declare({ name: "op", input: shape, answers: "whole" }, () => ({ outcome: "answered", answer: 1 })), endpoints: ["svc/op"] });
	await raw.send("svc/op", request("op", 5));
	await raw.send("svc/op", request("op", 5, { extra: 1 }));
	await raw.repliesReach(2);
	const [misfit, malformed] = raw.replies.map((r) => r.payload.refusal);
	assert.deepEqual(Object.keys(misfit).sort(), [...EM9_FIELDS, "misfits"].sort());
	assert.equal(misfit.part, "operation-call");
	assert.equal(misfit.code, "input-misfit");
	assert.deepEqual(misfit.details, {});
	assert.deepEqual(misfit.misfits, [{ pointer: "", keyword: "type", expected: "string", fit: "a value of type string" }]);
	assert.deepEqual(Object.keys(malformed).sort(), EM9_FIELDS);
	assert.equal(malformed.code, "malformed-request");
	assert.deepEqual(malformed.details, {});
	for (const r of [misfit, malformed]) for (const f of ["what", "why", "fix"]) assert.ok(r[f].length > 0, `${r.code} says ${f}`);
	const topology = await openTopology({ makeCaller: false });
	t.after(() => topology.close());
	const { createCaller } = await import("@apnex/operation-call");
	const caller = await createCaller({ node: topology.callerNode, clock: topology.callClock });
	const notSendable = (await caller.invoke({ host: "host-a", service: "svc", operation: "op", input: 2 ** 60, bound: 100 })).refusal;
	assert.deepEqual(Object.keys(notSendable).sort(), EM9_FIELDS);
	assert.equal(notSendable.part, "operation-call");
	assert.equal(notSendable.code, "not-sendable");
	assert.deepEqual(notSendable.details, {});
});

test("a request breaking EM11's form, or naming another operation than its endpoint's, is refused as malformed-request under its label; one whose label is no attempt identity is discarded", async (t) => {
	let runs = 0;
	const raw = await openRaw(t, { declare: (host) => host.declare({ name: "op", input: ANY, answers: "whole" }, () => { runs++; return { outcome: "answered", answer: 1 }; }), endpoints: ["svc/op"] });
	const otherAttempt = `${INVOCATION}.00000001`;
	const malformed = [
		request("op", {}, { operationCall: 2 }), request("op", {}, { type: "end" }), request("op", {}, { input: undefined }),
		request("op", {}, { attempt: "1791540000001-0123456789abcdef.89abcdef" }), request("other", {}), request("op", {}, { attempt: otherAttempt }),
		{ unrelated: true },
	];
	for (const payload of malformed) await raw.send("svc/op", payload);
	await raw.repliesReach(malformed.length);
	for (const { payload, delivery } of raw.replies) {
		assert.deepEqual(payload, end("refused", { refusal: payload.refusal }), "answered under the label's attempt, for the endpoint's operation");
		assert.equal(payload.refusal.code, "malformed-request");
		assert.equal(delivery.correlationId, ATTEMPT);
	}
	await raw.send("svc/op", request("op", {}, { operationCall: 2 }), "not-an-attempt");
	await raw.send("svc/op", request("op", {}, { operationCall: 2 }), null);
	await raw.send("svc/op", request("op", {}), "not-an-attempt");
	for (let i = 0; i < 50; i++) await turn();
	assert.equal(raw.replies.length, malformed.length, "a request whose label is no attempt identity is discarded, unanswered");
	assert.equal(runs, 0, "no operation ran for any of them");
});

test("an operation's refusal that is not in EM9's form ends the invocation failed with operation-threw, never as a refusal", async (t) => {
	const bad = [
		{ part: "x", code: "y", what: "w", why: "w", fix: "f" },
		{ part: "x", code: "y", what: "w", why: "w", fix: "f", details: {}, extra: 1 },
		{ part: "x", code: 3, what: "w", why: "w", fix: "f", details: {} },
		{ part: "x", code: "y", what: "w", why: "w", fix: "f", details: [] },
		{ part: "x", code: "y", what: "w", why: "w", fix: "f", details: {}, misfits: [{ pointer: "" }] },
	];
	const raw = await openRaw(t, { declare: (host) => host.declare({ name: "op", input: ANY, answers: "whole" }, (input) => ({ outcome: "refused", refusal: bad[input] })), endpoints: ["svc/op"] });
	for (let i = 0; i < bad.length; i++) await raw.send("svc/op", request("op", i, { attempt: `${INVOCATION}.0000000${i}` }), `${INVOCATION}.0000000${i}`);
	await raw.repliesReach(bad.length);
	for (const { payload } of raw.replies) assert.deepEqual(payload, end("failed", { reason: "operation-threw", agpCode: null }, payload.attempt));
});

test("a refusal whose misfits exceed what AGP carries ends the call unknown with answer-not-sendable and AGP's code, the named limit of the first version", async (t) => {
	const topology = await openTopology();
	t.after(() => topology.close());
	const { createOperationHost } = await import("@apnex/operation-call");
	const opening = await createOperationHost(topology.hosts[0].node, { service: "svc" });
	const misfits = Array.from({ length: 20000 }, (_, i) => ({ pointer: `/${i}`, keyword: "type", expected: "string", fit: "a value of type string, padded to be large".repeat(2) }));
	await opening.host.declare({ name: "op", input: ANY, answers: "whole" }, () => ({ outcome: "refused", refusal: { part: "fixture-store", code: "misfit", what: "w", why: "w", fix: "f", details: {}, misfits } }));
	await topology.hooks.ready("host-a", "svc/op");
	const ending = await topology.caller.invoke({ host: "host-a", service: "svc", operation: "op", input: {}, bound: 1000 });
	assert.equal(ending.ending, "unknown");
	assert.equal(ending.reason, "answer-not-sendable");
	assert.equal(ending.agpCode, "MESSAGE_TOO_LARGE");
});
