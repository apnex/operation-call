/**
 * What a caller observes beyond the endings' events (zorg's target, EM10 and EM12; zorg's E6, E8): a
 * programming error is thrown, never an ending, and nothing is sent; every ending is one frozen object
 * holding exactly its fields; a rejected send with no AGP code is recorded with `INTERNAL`; and a host's
 * description reads the same remotely as it was declared.
 */
import type { CallEnding } from "../call-types.js";
import { check, same, settle, until, watch } from "./suite-check.js";
import { ANY_INPUT, checkEndingFields, checkNotDelivered, FIXTURE_OPERATIONS, inCase, invokeExactly, runOutBound, SERVICE, SHAPED_INPUT, STRICT_INPUT, type CaseContext } from "./suite-support.js";
import type { SuiteCase } from "./suite-types.js";

/** A call to `echo` on host `a` that is valid in every argument. */
function validCall(c: CaseContext): { [name: string]: unknown } {
	return { host: c.a.nodeId, service: SERVICE, operation: "echo", input: {}, bound: 1000 };
}

/**
 * Checks that each change to a valid call makes invoke reject with the error class given and send nothing;
 * then that the valid call itself is sent, so the count the check reads moves when something is sent.
 */
async function checkProgrammingErrors(c: CaseContext, changes: readonly (readonly [string, { [name: string]: unknown }])[], kind: RangeErrorConstructor | TypeErrorConstructor): Promise<void> {
	const before = c.hooks.requests();
	for (const [what, change] of changes) {
		let error: unknown;
		try {
			await invokeExactly(c, { ...validCall(c), ...change });
		} catch (thrown) {
			error = thrown;
		}
		check(error !== undefined, `${what}: invoke throws rather than ending`);
		check(error instanceof kind, `${what}: a ${kind.name}, not ${String(error)}`);
	}
	c.hooks.advanceAgpClock(0);
	await settle();
	same(c.hooks.requests(), before, "nothing was sent for any of them");
	same(c.a.runs.length + c.b.runs.length, 0, "no operation ran");
	same((await invokeExactly(c, validCall(c))).ending, "answered", "the same call with valid arguments is answered");
	same(c.hooks.requests(), before + 1, "and was sent");
}

/** A value holding itself. */
function cyclic(): unknown {
	const value: { [name: string]: unknown } = {};
	value.self = value;
	return value;
}

export const boundArgumentCases: readonly SuiteCase[] = [
	{
		name: "a bound that is not a whole number of milliseconds from 1 to 2147483647 throws a RangeError, and nothing is sent",
		run: (h) => inCase(h, {}, async (c) => {
			const bounds = [0, -1, 2147483648, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "5", undefined, null];
			await checkProgrammingErrors(c, bounds.map((bound) => [`a bound of ${String(bound)}`, { bound }] as const), RangeError);
		}),
	},
];

export const identityArgumentCases: readonly SuiteCase[] = [
	{
		name: "an invocation identity not as EM11 writes it throws a TypeError, and nothing is sent",
		run: (h) => inCase(h, {}, async (c) => {
			const identities = ["", "1791540000000-ABCDEF0123456789", "179154000000-abcdef0123456789", "1791540000000-abcdef012345678", "1791540000000_abcdef0123456789", "1791540000000-abcdef0123456789.12345678", 17, null];
			await checkProgrammingErrors(c, identities.map((invocation) => [`the invocation ${String(invocation)}`, { invocation }] as const), TypeError);
		}),
	},
];

export const callArgumentCases: readonly SuiteCase[] = [
	{
		name: "a service or operation breaking EM1's pattern, or an input that is not a JSON value, throws a TypeError, and nothing is sent",
		run: (h) => inCase(h, {}, async (c) => {
			await checkProgrammingErrors(c, [
				["the service Fixture", { service: "Fixture" }], ["an empty service", { service: "" }], ["a service of 64 characters", { service: "f".repeat(64) }], ["a service that is not a string", { service: 7 }],
				["the operation Echo", { operation: "Echo" }], ["an operation with a slash", { operation: "echo/x" }], ["an operation of 64 characters", { operation: "e".repeat(64) }], ["no operation", { operation: undefined }],
				["an input holding itself", { input: cyclic() }], ["an input of NaN", { input: Number.NaN }], ["an input holding Infinity", { input: [Number.POSITIVE_INFINITY] }],
				["an input of a BigInt", { input: 1n }], ["an undefined input", { input: undefined }], ["an input holding a function", { input: { f: () => 1 } }], ["an input of a Date", { input: new Date(0) }],
			], TypeError);
		}),
	},
	{
		name: "every ending is one frozen object holding exactly its fields: answered, refused by the operation, by the shape and before sending, and unknown when the operation failed, its answer could not be sent, and at the bound",
		run: (h) => inCase(h, {}, async (c) => {
			const answered = await c.ended({ operation: "echo", input: { a: [1] } });
			checkEndingFields(answered, "answered");
			const refusal = { part: "fixture-store", code: "revision-moved", what: "w", why: "w", fix: "f", details: { n: 1 } };
			const refused = await c.ended({ operation: "refuses", input: refusal });
			checkEndingFields(refused, "refused by the operation");
			const misfit = await c.ended({ operation: "strict", input: { n: "x" } });
			checkEndingFields(misfit, "refused as input-misfit");
			const unsendable = await c.ended({ operation: "echo", input: 2 ** 60 });
			checkEndingFields(unsendable, "refused as not-sendable");
			const failed = await c.ended({ operation: "throws" });
			checkEndingFields(failed, "unknown with operation-failed");
			let deep: unknown = 0;
			for (let i = 0; i < 29; i++) deep = [deep];
			const notSendable = await c.ended({ operation: "deeper", input: deep as never });
			checkEndingFields(notSendable, "unknown with answer-not-sendable");
			const silent = watch(c.call({ operation: "silent", bound: 100 }));
			await until(() => c.a.runs.some((r) => r.operation === "silent"), "the silent operation runs");
			const atBound = await runOutBound(c, silent, 100, { ending: "the ending at the bound" });
			checkEndingFields(atBound, "unknown at the bound");
			same([answered, refused, misfit, unsendable, failed, notSendable, atBound].map((e) => e?.ending), ["answered", "refused", "refused", "refused", "unknown", "unknown", "unknown"], "the kinds of the endings");
		}),
	},
];

export const repeatArgumentCases: readonly SuiteCase[] = [
	{
		name: "a repeat flag that is not a boolean throws a TypeError, and nothing is sent",
		run: (h) => inCase(h, {}, async (c) => {
			const flags = [1, 0, "true", null, {}];
			await checkProgrammingErrors(c, flags.map((repeat) => [`a repeat flag of ${JSON.stringify(repeat)}`, { repeat }] as const), TypeError);
		}),
	},
	{
		name: "a not-delivered ending is one frozen object holding exactly its address, AGP's code unchanged, a null proxy code, and whether earlier attempts are uncertain",
		run: (h) => inCase(h, {}, async (c) => {
			const fresh = await c.ended({ operation: "not-declared" }) as CallEnding;
			checkEndingFields(fresh, "a not-delivered ending");
			checkNotDelivered(fresh, ["NO_ROUTE"], false, "a not-delivered ending");
			same(fresh.operation, "not-declared", "the operation's name");
			const repeated = await c.ended({ operation: "not-declared", invocation: fresh.invocation, repeat: true });
			checkEndingFields(repeated, "a repeat not delivered");
			checkNotDelivered(repeated, ["NO_ROUTE"], true, "a repeat not delivered");
			same(repeated.invocation, fresh.invocation, "the same invocation");
		}),
	},
	{
		name: "a send rejected with no AGP code ends not delivered with INTERNAL, never a refusal",
		run: (h) => inCase(h, {}, async (c) => {
			c.hooks.failNextSend();
			const ending = await c.ended({ operation: "echo", input: "never sent" });
			checkEndingFields(ending, "a send rejected with no code");
			checkNotDelivered(ending, ["INTERNAL"], false, "a send rejected with no code");
			same(c.a.runs.length, 0, "the request never arrived");
			same((await c.ended({ operation: "echo", input: "after" })).ending, "answered", "the next call is sent and answered");
		}),
	},
];

export const descriptionCases: readonly SuiteCase[] = [
	{
		name: "a caller reads a host's description remotely: every declared input shape unchanged, ordered by name, whole, and describe itself not listed",
		run: (h) => inCase(h, {}, async (c) => {
			const ending = await c.ended({ operation: "describe", input: {} });
			same(ending.ending, "answered", "describe answers");
			if (ending.ending !== "answered") return;
			const shapes: { [name: string]: unknown } = { strict: STRICT_INPUT, shaped: SHAPED_INPUT };
			const names = [...FIXTURE_OPERATIONS].sort();
			same(ending.answer, { service: SERVICE, operations: names.map((name) => ({ name, input: shapes[name] ?? ANY_INPUT, answers: "whole" })) }, "the description");
			const shaped = (ending.answer as { operations: { name: string; input: { [n: string]: unknown } }[] }).operations.find((o) => o.name === "shaped");
			same(Object.keys(shaped?.input ?? {}), Object.keys(SHAPED_INPUT), "the shape's names in the order declared");
			same(Object.keys((shaped?.input.properties ?? {}) as object), Object.keys(SHAPED_INPUT.properties), "nested names in the order declared");
			const fromB = await c.ended({ operation: "describe", input: {}, host: c.b.nodeId });
			same(fromB.ending === "answered" ? fromB.answer : undefined, ending.answer, "the other host, declaring the same, describes the same");
		}),
	},
	{
		name: "describe takes only an empty object: other input is refused as input-misfit, and an echo of the described shape fits it",
		run: (h) => inCase(h, {}, async (c) => {
			const misfit = await c.ended({ operation: "describe", input: { any: 1 } });
			same(misfit.ending, "refused", "the ending");
			if (misfit.ending === "refused") same([misfit.refusal.part, misfit.refusal.code], ["operation-call", "input-misfit"], "refused by operation-call as input-misfit");
			const fits = await c.ended({ operation: "shaped", input: { "z\u00e9ta": "abc", alpha: 2.5 } });
			same(fits.ending, "answered", "input fitting the described shape is answered");
			const misfits = await c.ended({ operation: "shaped", input: { "z\u00e9ta": "abcd" } });
			same(misfits.ending === "refused" ? misfits.refusal.code : misfits.ending, "input-misfit", "input breaking the described shape is refused");
		}),
	},
];
