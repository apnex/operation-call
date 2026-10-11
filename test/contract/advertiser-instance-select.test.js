// advertiser-instance-select (carried from AGP) - a caller may name the instance it means; operation-call
// passes it on and never chooses one (zorg's target, EM11; zorg's D7; zorg's E8).
//
// The fixture runs two AGP nodes advertising the same operation names. The caller suite's cases for this
// row run directly against operation-call's own caller: a call pinned to a named host never reaches the
// other advertiser; a call pinned to an unavailable host is refused by AGP, not delivered, and handled by no
// host; and an undeclared operation is refused before any handler runs. Beside them: every request carries
// AGP's pinned selector naming the caller's host, and the answer is taken only from that host.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createOperationHost } from "@apnex/operation-call";
import { registerCallerSuite } from "@apnex/operation-call/caller-suite";
import { directHarness, openTopology } from "../support/fixture.js";

registerCallerSuite((name, run) => test(name, { timeout: 30_000 }, run), directHarness, ["advertiser-instance-select"]);

test("with both hosts advertising the same names, each call goes to the host it names, whichever AGP selected, and AGP's selector carries the pin", async (t) => {
	const topology = await openTopology();
	t.after(() => topology.close());
	for (const { node } of topology.hosts) {
		const { host } = await createOperationHost(node, { service: "svc" });
		await host.declare({ name: "op", input: { $schema: "urn:apnex:shape-check:dialect:1" }, answers: "whole" }, (_i, c) => ({ outcome: "answered", answer: { host: node.nodeId, origin: c.delivery.source.originNodeId } }));
	}
	for (const h of ["host-a", "host-b"]) await topology.hooks.ready(h, "svc/op");
	const selected = topology.callerNode.operations.routes().selected.find((r) => r.endpoint === "svc/op").originNodeId;
	const other = selected === "host-a" ? "host-b" : "host-a";
	const sends = [];
	const send = topology.sendingNode.send;
	topology.sendingNode.send = (...args) => { sends.push(args[3]); return send(...args); };
	for (const h of [other, selected, other]) {
		const ending = await topology.caller.invoke({ host: h, service: "svc", operation: "op", input: {}, bound: 1000 });
		assert.deepEqual(ending.answer, { host: h, origin: "caller" }, `answered by ${h}`);
	}
	assert.deepEqual(sends.map((o) => o.destinationSelector), [other, selected, other].map((h) => ({ originNodeId: h, mode: "pinned" })));
});
