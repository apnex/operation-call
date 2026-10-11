// operation-descriptions - operations are declared as data - name, input shape, whether the answer comes
// whole or in parts - and a caller can read what a host offers (zorg's target, EM10; zorg's E8).
//
// A host refuses a name other than EM1's, and an input shape nesting more than 20 levels, refused by
// shape-check, or holding an integer beyond the safe range, and a declaration making its description exceed
// 524288 bytes, in that order, depth measured before shape-check judges the shape; a refused declaration
// exposes no endpoint and leaves the description as it was. Cases: each reason, its order, shapes of 20,
// 21 and 5000 levels, a single shape too large to describe, two that fit alone but not together,
// descriptions of exactly 524288 bytes and one more. The caller suite's cases for this row, which a caller
// observes, run directly against operation-call's own caller: a remote description returning every declared
// input shape unchanged, in its declared order of names, from either host, and describe taking only an empty
// object.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createNode } from "@agp/node";
import { judgeShapeValue } from "@apnex/shape-check";
import { createOperationHost } from "@apnex/operation-call";
import { registerCallerSuite } from "@apnex/operation-call/caller-suite";
import { directHarness } from "../support/fixture.js";

registerCallerSuite((name, run) => test(name, { timeout: 30_000 }, run), directHarness, ["operation-descriptions"]);

const D = "urn:apnex:shape-check:dialect:1";
const ok = () => ({ outcome: "answered", answer: null });
const endpoints = (node) => node.operations.endpoints().items.map((e) => e.endpoint).sort();
const byCodePoint = (a, b) => { const x = [...a].map((c) => c.codePointAt(0)); const y = [...b].map((c) => c.codePointAt(0)); for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i]; return x.length - y.length; };
const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v !== null && typeof v === "object" ? `{${Object.keys(v).sort(byCodePoint).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v);
const bytes = (v) => Buffer.byteLength(canonical(v), "utf8");
/** A shape of `levels` levels: `items` nested inside one another. */
const deepShape = (levels) => { let s = { type: "integer" }; for (let i = 2; i < levels; i++) s = { items: s }; return levels === 1 ? { $schema: D } : { $schema: D, items: s }; };
const enumShape = (n) => ({ $schema: D, enum: ["x".repeat(n)] });

async function freshHost(service = "svc") {
	const node = createNode({ nodeId: "host" });
	const opening = await createOperationHost(node, { service });
	assert.equal(opening.opened, true);
	return { node, host: opening.host };
}

test("a host serves only under a name EM1's pattern allows, and exposes nothing when it refuses", async () => {
	for (const service of ["Svc", "", "-svc", "s_v", "a".repeat(64)]) {
		const node = createNode({ nodeId: "host" });
		const opening = await createOperationHost(node, { service });
		assert.deepEqual({ opened: opening.opened, code: opening.refusal?.code, details: opening.refusal?.details }, { opened: false, code: "invalid-name", details: { name: service } });
		assert.equal(typeof opening.refusal.message, "string");
		assert.deepEqual(endpoints(node), []);
	}
	const long = await createOperationHost(createNode({ nodeId: "host" }), { service: "\u00e9".repeat(200) });
	assert.deepEqual(long.refusal.details, { name: "\u00e9".repeat(128), truncated: true });
	const { node, host } = await freshHost("a".repeat(63));
	assert.deepEqual(endpoints(node), [`${"a".repeat(63)}/describe`]);
	assert.deepEqual(host.description(), { service: "a".repeat(63), operations: [] });
});

test("each reason a declaration is refused, with its details, exposing no endpoint and leaving the description as it was", async () => {
	const { node, host } = await freshHost();
	assert.deepEqual(await host.declare({ name: "kept", input: { $schema: D }, answers: "whole" }, ok), { declared: true });
	const before = host.description();
	const refusedShape = { type: "strng" };
	const cases = [
		[{ name: "Bad", input: { $schema: D } }, "invalid-name", { name: "Bad" }],
		[{ name: "x".repeat(64), input: { $schema: D } }, "invalid-name", { name: "x".repeat(64) }],
		[{ name: "describe", input: { $schema: D } }, "invalid-name", { name: "describe" }],
		[{ name: "kept", input: { $schema: D } }, "invalid-name", { name: "kept" }],
		[{ name: "deep", input: deepShape(21) }, "shape-too-deep", { name: "deep", depth: 21, limit: 20 }],
		[{ name: "deeper", input: deepShape(5000) }, "shape-too-deep", { name: "deeper", depth: 5000, limit: 20 }],
		[{ name: "refused", input: refusedShape }, "shape-refused", { name: "refused", problems: judgeShapeValue(refusedShape, 0).problems }],
		[{ name: "unsafe", input: { $schema: D, const: 9007199254740992 } }, "unsafe-shape", { name: "unsafe", pointer: "/const" }],
		[{ name: "unsafe-nested", input: { $schema: D, properties: { a: { enum: [1, -9007199254740992] } } } }, "unsafe-shape", { name: "unsafe-nested", pointer: "/properties/a/enum/1" }],
		[{ name: "large", input: enumShape(600000) }, "description-too-large", { name: "large", bytes: bytes({ operations: [...before.operations, { name: "large", input: enumShape(600000), answers: "whole" }], service: "svc" }), limit: 524288 }],
	];
	for (const [declaration, code, details] of cases) {
		const outcome = await host.declare({ ...declaration, answers: "whole" }, ok);
		assert.equal(outcome.declared, false, declaration.name);
		assert.equal(outcome.refusal.code, code, declaration.name);
		assert.deepEqual(outcome.refusal.details, details, declaration.name);
		assert.equal(typeof outcome.refusal.message, "string");
		assert.deepEqual(host.description(), before, `${declaration.name} leaves the description as it was`);
		assert.deepEqual(endpoints(node), ["svc/describe", "svc/kept"], `${declaration.name} exposes no endpoint`);
	}
});

test("the reasons are checked in EM10's order: name, depth before shape-check, shape-check, unsafe integers, description size", async () => {
	const { host } = await freshHost();
	const code = async (name, input) => (await host.declare({ name, input, answers: "whole" }, ok)).refusal?.code;
	const deepRefusedUnsafe = deepShape(21);
	deepRefusedUnsafe.unknownKeyword = 9007199254740992;
	assert.equal(await code("Bad", deepRefusedUnsafe), "invalid-name");
	assert.equal(await code("a", deepRefusedUnsafe), "shape-too-deep", "a 21-level shape is refused before shape-check would refuse it");
	assert.equal(await code("b", { $schema: D, unknownKeyword: 9007199254740992, enum: ["x".repeat(600000)] }), "shape-refused");
	assert.equal(await code("c", { $schema: D, const: 9007199254740992, enum: ["x".repeat(600000)] }), "unsafe-shape");
	assert.deepEqual(await host.declare({ name: "twenty", input: deepShape(20), answers: "whole" }, ok), { declared: true }, "a shape of exactly 20 levels is declared");
});

test("a declaration whose shape is not JSON, or that answers in parts, is a programming error thrown before anything is judged or exposed", async () => {
	const { node, host } = await freshHost();
	const cyclic = { $schema: D };
	cyclic.properties = { self: cyclic };
	for (const input of [cyclic, undefined, () => 1, { $schema: D, const: Number.NaN }, { $schema: D, enum: [1n] }]) {
		assert.throws(() => host.declare({ name: "bad", input, answers: "whole" }, ok), TypeError);
	}
	assert.throws(() => host.declare({ name: "parts", input: { $schema: D }, answers: "parts" }, ok), TypeError, "answers in parts are deferred, D15");
	assert.throws(() => host.declare({ name: "neither", input: { $schema: D } }, ok), TypeError);
	assert.throws(() => host.declare({ name: "nohandler", input: { $schema: D }, answers: "whole" }), TypeError);
	assert.deepEqual(endpoints(node), ["svc/describe"]);
});

test("descriptions of exactly 524288 bytes are declared, and of one byte more refused; a single shape too large and two that fit only alone are refused", async () => {
	const base = bytes({ operations: [{ answers: "whole", input: enumShape(0), name: "big" }], service: "svc" });
	const exact = await freshHost();
	assert.deepEqual(await exact.host.declare({ name: "big", input: enumShape(524288 - base), answers: "whole" }, ok), { declared: true });
	assert.equal(bytes(exact.host.description()), 524288);
	const over = await freshHost();
	const refused = await over.host.declare({ name: "big", input: enumShape(524288 - base + 1), answers: "whole" }, ok);
	assert.deepEqual(refused.refusal.details, { name: "big", bytes: 524289, limit: 524288 });
	const pair = await freshHost();
	assert.deepEqual(await pair.host.declare({ name: "one", input: enumShape(300000), answers: "whole" }, ok), { declared: true });
	const second = await pair.host.declare({ name: "two", input: enumShape(300000), answers: "whole" }, ok);
	assert.equal(second.refusal.code, "description-too-large", "two shapes that fit alone but not together");
	assert.deepEqual(pair.host.description().operations.map((o) => o.name), ["one"]);
	assert.deepEqual(endpoints(pair.node), ["svc/describe", "svc/one"]);
	const alone = await freshHost();
	assert.deepEqual(await alone.host.declare({ name: "two", input: enumShape(300000), answers: "whole" }, ok), { declared: true }, "the second shape fits alone");
});
