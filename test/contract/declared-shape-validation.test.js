// declared-shape-validation (carried from shape-check) - input is checked against the operation's declared
// shape before the operation runs, and a misfit is refused (shape-check's SD7; zorg's target, EM9, EM10;
// zorg's E9).
//
// For every case of shape-check's corpus, read through its public data path, a fixture host on AGP's
// production in-process carrier declares one operation whose input shape is the case's shape, and a caller
// invokes it with the case's value: a refused shape makes the declaration fail with the case's problems; a
// misfit ends the call refused as input-misfit with the case's misfits, the operation never running; a fit
// reaches the operation. E9's comparison: the same value is also judged by entity-store as an entity body,
// and the records each component returns are the same, and the case's, in canonical JSON, byte for byte.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import corpus from "@apnex/shape-check/corpus" with { type: "json" };
import { createMemoryStoragePort, openEntityStore } from "@apnex/entity-store";
import { createOperationHost } from "@apnex/operation-call";
import { openTopology } from "../support/fixture.js";

const byCodePoint = (a, b) => {
	const x = Array.from(a, (c) => c.codePointAt(0));
	const y = Array.from(b, (c) => c.codePointAt(0));
	for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
	return x.length - y.length;
};
const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
	: v !== null && typeof v === "object" ? `{${Object.keys(v).sort(byCodePoint).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`
	: JSON.stringify(v);

/** entity-store's judgement of the case's value as an entity body (its declared-shape-validation). */
function asEntityBody(c) {
	const opening = openEntityStore({ storage: createMemoryStoragePort(), clock: { now: () => 0 }, historyMs: 60_000, maxEntityBytes: 262144, kinds: { kind: c.shape } });
	if (!opening.opened) return { refused: opening.refusal };
	return { outcome: opening.store.create({ kind: "kind", name: "case", tags: [], body: c.value }, { writer: "corpus", writeId: "corpus" }) };
}

let topology;
before(async () => { topology = await openTopology(); });
after(async () => { await topology?.close(); });

test("the corpus is read through shape-check's public data path and holds cases of every verdict", () => {
	assert.ok(corpus.cases.length > 0);
	assert.deepEqual([...new Set(corpus.cases.map((c) => c.verdict.verdict))].sort(), ["fits", "misfit", "shape-refused"]);
});

corpus.cases.forEach((c, index) => {
	test(`corpus: ${c.name}`, { timeout: 30_000 }, async () => {
		const service = `case-${index}`;
		const ran = [];
		const opening = await createOperationHost(topology.hosts[0].node, { service });
		assert.equal(opening.opened, true);
		const { host } = opening;
		try {
			const declared = await host.declare({ name: "judge", input: c.shape, answers: "whole" }, (input) => { ran.push(input); return { outcome: "answered", answer: input }; });
			const store = asEntityBody(c);
			if (c.verdict.verdict === "shape-refused") {
				assert.equal(declared.declared, false, "a refused shape makes the declaration fail");
				assert.equal(declared.refusal.code, "shape-refused");
				assert.equal(canonical(declared.refusal.details.problems), canonical(c.verdict.problems), "the case's problems, byte for byte");
				assert.equal(canonical(declared.refusal.details.problems), canonical(store.refused.details.problems), "the same problems entity-store gives");
				assert.deepEqual(topology.hosts[0].node.operations.endpoints().items.map((e) => e.endpoint).filter((e) => e.startsWith(`${service}/`)), [`${service}/describe`], "no endpoint exposed");
				return;
			}
			assert.deepEqual(declared, { declared: true });
			await topology.hooks.ready("host-a", `${service}/judge`);
			const ending = await topology.caller.invoke({ host: "host-a", service, operation: "judge", input: c.value, bound: 10_000 });
			if (c.verdict.verdict === "misfit") {
				assert.equal(ending.ending, "refused", JSON.stringify(ending));
				assert.equal(ending.refusal.part, "operation-call");
				assert.equal(ending.refusal.code, "input-misfit");
				assert.deepEqual(ending.refusal.details, {});
				assert.equal(canonical(ending.refusal.misfits), canonical(c.verdict.misfits), "the case's misfits, unchanged, byte for byte");
				assert.equal(store.outcome.refusal.code, "misfit");
				assert.equal(canonical(ending.refusal.misfits), canonical(store.outcome.refusal.misfits), "the same misfit records as an entity body");
				assert.deepEqual(ran, [], "the operation never ran");
			} else {
				assert.equal(ending.ending, "answered", JSON.stringify(ending));
				assert.equal(canonical(ran), canonical([c.value]), "a fit reaches the operation with the value as sent");
				assert.equal(store.outcome.outcome, "answered", "entity-store accepts the same value");
			}
		} finally {
			await host.close();
		}
	});
});
