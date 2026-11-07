// request-correlation - a reply or a delivery report is paired with the attempt it answers; each attempt
// carries its own correlation in AGP's correlation label, so a late reply to an earlier attempt is never
// taken for a later one's (zorg's target, EM11; zorg's D4; zorg's E6, AGP's third consumer-handoff case).
//
// The caller suite's cases for this row run directly against operation-call's own caller: a late reply to
// an earlier attempt never completes a later one; no delivery report is taken for an answer; the attempt is
// the label of the request and of its answer; and messages from another node, endpoint or operation, under
// another label, out of form, or a part, are discarded. Beside them: the caller counts what it discards, and
// the host answers under the request's label, from the operation's endpoint, pinned to the request's origin.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createOperationHost } from "@apnex/operation-call";
import { registerCallerSuite } from "@apnex/operation-call/caller-suite";
import { writeEnd } from "@apnex/operation-call/message-format";
import { directHarness, openTopology, turn, until } from "../support/fixture.js";

registerCallerSuite((name, run) => test(name, { timeout: 30_000 }, run), directHarness, ["request-correlation"]);

const ANY = { $schema: "urn:apnex:shape-check:dialect:1" };

test("the caller counts every message its reply endpoint discards, and takes the one that matches", async (t) => {
	const topology = await openTopology();
	t.after(() => topology.close());
	const [hostA] = topology.hosts;
	const opening = await createOperationHost(hostA.node, { service: "svc" });
	let release;
	const held = new Promise((resolve) => { release = resolve; });
	let attempt;
	await opening.host.declare({ name: "op", input: ANY, answers: "whole" }, async (_input, context) => {
		attempt = context;
		await held;
		return { outcome: "answered", answer: "real" };
	});
	await topology.hooks.ready("host-a", "svc/op");
	const ending = topology.caller.invoke({ host: "host-a", service: "svc", operation: "op", input: {}, bound: 1000 });
	await until(() => attempt !== undefined, "the operation runs");
	assert.equal(topology.caller.discarded(), 0);
	const address = { invocation: attempt.invocation, attempt: attempt.attempt, operation: "op" };
	const pin = { destinationSelector: { originNodeId: "caller", mode: "pinned" } };
	await hostA.node.send("svc/op", "operation-call/replies", writeEnd(address, { outcome: "answered", answer: "forged" }), { ...pin, correlationId: `${attempt.invocation}.ffffffff` });
	await hostA.node.send("svc/op", "operation-call/replies", { operationCall: 1, type: "end" }, { ...pin, correlationId: attempt.attempt });
	await hostA.node.send("svc/op", "operation-call/replies", writeEnd(address, { outcome: "answered", answer: "no label" }), pin);
	await until(() => topology.caller.discarded() === 3, "three messages discarded");
	release();
	const result = await ending;
	assert.equal(result.ending, "answered");
	assert.equal(result.answer, "real");
	await hostA.node.send("svc/op", "operation-call/replies", writeEnd(address, { outcome: "answered", answer: "late" }), { ...pin, correlationId: attempt.attempt });
	await until(() => topology.caller.discarded() === 4, "a message for an attempt no longer waiting is discarded");
});

test("the host answers under the request's correlation label, from the operation's endpoint, pinned to the request's origin node", async (t) => {
	const topology = await openTopology({ makeCaller: false });
	t.after(() => topology.close());
	const [hostA] = topology.hosts;
	const opening = await createOperationHost(hostA.node, { service: "svc" });
	await opening.host.declare({ name: "op", input: ANY, answers: "whole" }, (input) => ({ outcome: "answered", answer: input }));
	const replies = [];
	await topology.callerNode.expose("operation-call/replies", async (payload, context) => { replies.push({ payload, delivery: context.delivery }); });
	await topology.hooks.ready("host-a", "svc/op");
	const attempt = "1791540000000-0123456789abcdef.89abcdef";
	await topology.callerNode.send("operation-call/replies", "svc/op",
		{ operationCall: 1, type: "request", invocation: "1791540000000-0123456789abcdef", attempt, operation: "op", input: [1] },
		{ correlationId: attempt, destinationSelector: { originNodeId: "host-a", mode: "pinned" } });
	await until(() => replies.length === 1, "the answer");
	const [{ payload, delivery }] = replies;
	assert.deepEqual(payload, { operationCall: 1, type: "end", invocation: "1791540000000-0123456789abcdef", attempt, operation: "op", outcome: "answered", answer: [1] });
	assert.equal(delivery.correlationId, attempt);
	assert.deepEqual(delivery.source, { endpoint: "svc/op", originNodeId: "host-a" });
	assert.deepEqual(delivery.directPeer, { originNodeId: "host-a", authorizationAssociation: { mode: "unauthenticated" } });
	await turn();
});

test("D11-E1: when two sessions share an originNodeId with distinct instanceBindings, the host's sendDirectPeer reply reaches only the requesting session's directPeer target", async (t) => {
	const topology = await openTopology({
		makeCaller: false,
		identityAdmission: {
			evaluate: async (req) => ({
				decision: "allow",
				authorizationAssociation: {
					mode: "authenticated",
					issuer: "zorg-credential-issuer/v1",
					principal: "alice",
					instanceBinding: `${req.remoteNodeId}:${req.remoteSessionId}`,
				},
			}),
		},
	});
	t.after(() => topology.close());
	const [hostA] = topology.hosts;
	const opening = await createOperationHost(hostA.node, { service: "svc", mode: "authenticated", minimumProtection: "none" });
	let seenDirectPeer;
	await opening.host.declare({ name: "op", input: ANY, answers: "whole" }, (input, context) => {
		seenDirectPeer = context.delivery.directPeer;
		return { outcome: "answered", answer: input };
	});
	const replies = [];
	await topology.callerNode.expose("operation-call/replies", async (payload, context) => { replies.push({ payload, delivery: context.delivery }); });
	await topology.hooks.ready("host-a", "svc/op");
	const attempt = "1791540000000-0123456789abcdef.89abcdef";
	await topology.callerNode.send("operation-call/replies", "svc/op",
		{ operationCall: 1, type: "request", invocation: "1791540000000-0123456789abcdef", attempt, operation: "op", input: "isolated" },
		{ correlationId: attempt, destinationSelector: { originNodeId: "host-a", mode: "pinned" } });
	await until(() => replies.length === 1, "the authenticated direct-peer answer");
	assert.equal(seenDirectPeer.originNodeId, "caller");
	assert.equal(seenDirectPeer.authorizationAssociation.mode, "authenticated");
	assert.equal(seenDirectPeer.authorizationAssociation.principal, "alice");
	assert.equal(replies[0].payload.answer, "isolated");
});
