// read-refusal-record - call-refusal: `readRefusalRecord` reads a candidate refusal as plain data through
// shape-check's readPlainJson (zorg's D54, D55), running none of its code, and accepts exactly EM9's form -
// `part`, `code`, `what`, `why` and `fix` non-empty strings, `details` an object, and, only beside them, a
// non-empty `misfits` list of SD4's misfit records - giving it deeply frozen, or `{ok: false}`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readRefusalRecord } from "@apnex/operation-call";

const refusal = () => ({ part: "entity-store", code: "not-found", what: "No such entity.", why: "It was deleted.", fix: "Create it.", details: { target: { id: "x" } } });
const misfit = () => ({ pointer: "/summary", keyword: "maxLength", expected: 1024, fit: "a string of length at most 1024" });

/** True when a value and every container in it are frozen. */
function deeplyFrozen(value) {
	const stack = [value];
	while (stack.length > 0) {
		const item = stack.pop();
		if (item === null || typeof item !== "object") continue;
		if (!Object.isFrozen(item)) return false;
		stack.push(...Object.values(item));
	}
	return true;
}

test("a refusal in EM9's form is read into a fresh deeply frozen copy", () => {
	const given = refusal();
	const reading = readRefusalRecord(given);
	assert.equal(reading.ok, true);
	assert.deepEqual(reading.refusal, given);
	assert.notEqual(reading.refusal, given);
	assert.ok(deeplyFrozen(reading.refusal));
	assert.ok(Object.isFrozen(reading));
	assert.deepEqual(readRefusalRecord({ ...refusal(), details: {} }).ok, true, "empty details");
});

test("a misfit refusal carries a non-empty list of SD4's misfit records, each expected any JSON value", () => {
	const given = { ...refusal(), code: "misfit", details: {}, misfits: [misfit(), { pointer: "", keyword: "type", expected: ["string", "null"], fit: "a value of type string or null" }, { pointer: "/a", keyword: "additionalProperties", expected: false, fit: "no property named \"a\"" }] };
	const reading = readRefusalRecord(given);
	assert.equal(reading.ok, true);
	assert.deepEqual(reading.refusal, given);
	assert.ok(deeplyFrozen(reading.refusal));
});

test("any field missing, extra, empty or of the wrong type is refused", () => {
	for (const name of ["part", "code", "what", "why", "fix", "details"]) {
		const missing = refusal();
		delete missing[name];
		assert.deepEqual(readRefusalRecord(missing), { ok: false }, `without ${name}`);
	}
	for (const name of ["part", "code", "what", "why", "fix"]) {
		assert.deepEqual(readRefusalRecord({ ...refusal(), [name]: "" }), { ok: false }, `${name} empty`);
		assert.deepEqual(readRefusalRecord({ ...refusal(), [name]: 1 }), { ok: false }, `${name} a number`);
		assert.deepEqual(readRefusalRecord({ ...refusal(), [name]: null }), { ok: false }, `${name} null`);
	}
	for (const details of [null, [], "x", 1]) assert.deepEqual(readRefusalRecord({ ...refusal(), details }), { ok: false });
	assert.deepEqual(readRefusalRecord({ ...refusal(), position: 3 }), { ok: false }, "an extra key");
	const proto = refusal();
	Object.defineProperty(proto, "__proto__", { value: {}, enumerable: true, writable: true, configurable: true });
	assert.deepEqual(readRefusalRecord(proto), { ok: false }, "an own __proto__ key is an extra key");
	for (const value of [null, undefined, "refused", 1, [refusal()]]) assert.deepEqual(readRefusalRecord(value), { ok: false });
});

test("misfits that are empty, not a list, or not exactly SD4's records are refused", () => {
	const withMisfits = (misfits) => ({ ...refusal(), misfits });
	assert.deepEqual(readRefusalRecord(withMisfits([])), { ok: false }, "an empty list");
	assert.deepEqual(readRefusalRecord(withMisfits(misfit())), { ok: false }, "not a list");
	assert.deepEqual(readRefusalRecord(withMisfits(null)), { ok: false });
	assert.deepEqual(readRefusalRecord(withMisfits([{ ...misfit(), keyword: "" }])), { ok: false }, "an empty keyword");
	assert.deepEqual(readRefusalRecord(withMisfits([{ ...misfit(), extra: 1 }])), { ok: false }, "an extra key");
	for (const name of ["pointer", "keyword", "expected", "fit"]) {
		const record = misfit();
		delete record[name];
		assert.deepEqual(readRefusalRecord(withMisfits([record])), { ok: false }, `without ${name}`);
	}
	for (const name of ["pointer", "keyword", "fit"]) assert.deepEqual(readRefusalRecord(withMisfits([{ ...misfit(), [name]: 1 }])), { ok: false }, `${name} a number`);
	assert.deepEqual(readRefusalRecord(withMisfits([misfit(), "x"])), { ok: false });
});

test("a refusal is read as plain data: getters never run, and custom prototypes, symbols and hidden fields are refused", () => {
	let calls = 0;
	const getter = refusal();
	Object.defineProperty(getter, "why", { get() { calls++; return "because"; }, enumerable: true });
	assert.deepEqual(readRefusalRecord(getter), { ok: false });
	const nestedGetter = { ...refusal(), details: { get x() { calls++; return 1; } } };
	assert.deepEqual(readRefusalRecord(nestedGetter), { ok: false });
	assert.equal(calls, 0);
	assert.deepEqual(readRefusalRecord(Object.assign(Object.create({ inherited: 1 }), refusal())), { ok: false });
	class Refusal { constructor() { Object.assign(this, refusal()); } }
	assert.deepEqual(readRefusalRecord(new Refusal()), { ok: false });
	assert.deepEqual(readRefusalRecord({ ...refusal(), [Symbol("s")]: 1 }), { ok: false });
	const hidden = refusal();
	Object.defineProperty(hidden, "misfits", { value: [misfit()], enumerable: false });
	assert.deepEqual(readRefusalRecord(hidden), { ok: false });
	assert.deepEqual(readRefusalRecord(new Proxy(refusal(), { ownKeys() { throw new Error("trap"); } })), { ok: false });
});

test("a refusal holding a native promise is refused, and the promise's rejection is consumed", async () => {
	let unhandled = 0;
	const listener = () => { unhandled++; };
	process.on("unhandledRejection", listener);
	try {
		assert.deepEqual(readRefusalRecord({ ...refusal(), details: { p: Promise.reject(new Error("details")) } }), { ok: false });
		assert.deepEqual(readRefusalRecord(Promise.reject(new Error("whole"))), { ok: false });
		for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 10));
	} finally {
		process.off("unhandledRejection", listener);
	}
	assert.equal(unhandled, 0);
});
