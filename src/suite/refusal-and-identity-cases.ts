/**
 * call-refusal, invocation-identity, advertiser-instance-select and the caller's view of
 * serve-named-operations (zorg's target, EM9, EM11 and EM12; zorg's E6, E8).
 */
import { judgeShapeValue } from "@apnex/shape-check";
import type { CallEnding } from "../call-types.js";
import { messageBytes, writeRequest } from "../message-format.js";
import { INVOCATION_PATTERN, isAttemptId } from "../names.js";
import { check, same, until, watch } from "./suite-check.js";
import { checkNotDelivered, inCase, untilEndedPumping } from "./suite-support.js";
import type { SuiteCase } from "./suite-types.js";

/** Checks an ending refused as not-sendable by operation-call, before anything was sent. */
function checkNotSendable(ending: CallEnding, what: string): void {
	same(ending.ending, "refused", `${what}: the ending`);
	if (ending.ending !== "refused") return;
	same(ending.refusal.part, "operation-call", `${what}: the part that refused`);
	same(ending.refusal.code, "not-sendable", `${what}: the code`);
	same(ending.refusal.details, {}, `${what}: no details`);
}

/** A value nested `levels` deep, alternating arrays and objects, built without recursion. */
function nested(levels: number, objects = false): unknown {
	let value: unknown = 0;
	for (let i = 0; i < levels; i++) value = objects && i % 2 === 1 ? { v: value } : [value];
	return value;
}

/** An input string making the request message exactly `bytes` bytes, for an invocation of operation echo. */
function inputOfRequestBytes(bytes: number): string {
	const overhead = messageBytes(writeRequest({ invocation: "0000000000000-0000000000000000", attempt: "0000000000000-0000000000000000.00000000", operation: "echo" }, "") as never);
	return "x".repeat(bytes - overhead);
}

export const callRefusalCases: readonly SuiteCase[] = [
	{
		name: "an operation's refusal reaches the caller unchanged, a reason another part supplied and its misfits included",
		run: (h) => inCase(h, {}, async (c) => {
			const plain = { part: "fixture-store", code: "revision-moved", what: "The revision moved.", why: "Another write landed first.", fix: "Read again, then write.", details: { expected: 1, current: 2 } };
			const misfit = { part: "fixture-store", code: "misfit", what: "The body does not fit.", why: "A kind's shape.", fix: "Fix the body.", details: {}, misfits: [{ pointer: "/summary", keyword: "maxLength", expected: 1024, fit: "a string of length at most 1024" }] };
			for (const refusal of [plain, misfit]) {
				const ending = await c.ended({ operation: "refuses", input: refusal });
				same(ending.ending, "refused", "the ending");
				if (ending.ending === "refused") same(ending.refusal, refusal, "the refusal, unchanged");
			}
		}),
	},
	{
		name: "input that does not fit the declared shape ends refused as input-misfit with shape-check's records, and the operation never runs",
		run: (h) => inCase(h, {}, async (c) => {
			const shape = { $schema: "urn:apnex:shape-check:dialect:1", type: "object", required: ["n"], properties: { n: { type: "integer" } }, additionalProperties: false };
			const input = { n: "seven", extra: true };
			const verdict = judgeShapeValue(shape, input);
			check(verdict.verdict === "misfit", "the fixture input misfits");
			const ending = await c.ended({ operation: "strict", input });
			same(ending.ending, "refused", "the ending");
			if (ending.ending === "refused") {
				same(ending.refusal.part, "operation-call", "the part that refused");
				same(ending.refusal.code, "input-misfit", "the code");
				same(ending.refusal.details, {}, "no details");
				same(ending.refusal.misfits, verdict.misfits, "shape-check's records, unchanged");
			}
			same(c.a.runs.length, 0, "the operation never ran");
		}),
	},
	{
		name: "a request of exactly 30 levels, the message counted, is sent and answered; one of 31 levels, or of 4000, is refused not-sendable before sending",
		run: (h) => inCase(h, {}, async (c) => {
			same((await c.ended({ operation: "echo", input: nested(29) as never })).ending, "answered", "a 30-level request");
			checkNotSendable(await c.ended({ operation: "echo", input: nested(30) as never }), "a 31-level request");
			checkNotSendable(await c.ended({ operation: "echo", input: nested(4000) as never }), "a 4000-level array input");
			checkNotSendable(await c.ended({ operation: "echo", input: nested(4000, true) as never }), "a 4000-level input of arrays and objects");
			same(c.a.runs.length, 1, "only the 30-level request reached the host");
		}),
	},
	{
		name: "integers 9007199254740991 from zero are sent and answered; one more, at the top or nested, is refused not-sendable before sending",
		run: (h) => inCase(h, {}, async (c) => {
			for (const input of [9007199254740991, -9007199254740991, { a: [1, 9007199254740991] }]) {
				same((await c.ended({ operation: "echo", input })).ending, "answered", `the safe input ${JSON.stringify(input)}`);
			}
			for (const input of [9007199254740992, -9007199254740992, { a: [1, { b: 9007199254740992 }] }, [2 ** 60]]) {
				checkNotSendable(await c.ended({ operation: "echo", input }), `the unsafe input ${JSON.stringify(input)}`);
			}
			same(c.a.runs.length, 3, "only the safe requests reached the host");
		}),
	},
	{
		name: "a request message of exactly 16777216 bytes is sent and ends not delivered with AGP's MESSAGE_TOO_LARGE; one byte more is refused not-sendable; another call in flight and a small one following are answered",
		run: (h) => inCase(h, {}, async (c) => {
			const inFlight = watch(c.call({ operation: "hold", bound: 10000 }));
			await until(() => c.a.holds.length === 1, "another call in flight");
			checkNotDelivered(await c.ended({ operation: "echo", input: inputOfRequestBytes(16777216) }), ["MESSAGE_TOO_LARGE"], false, "a request of 16777216 bytes");
			checkNotSendable(await c.ended({ operation: "echo", input: inputOfRequestBytes(16777217) }), "a request of 16777217 bytes");
			c.a.holds[0]?.release();
			await until(inFlight.settled, "the call in flight");
			same(inFlight.value()?.ending, "answered", "the call in flight is answered");
			same((await c.ended({ operation: "echo", input: "small" })).ending, "answered", "a small call following is answered");
		}),
	},
];

export const invocationIdentityCases: readonly SuiteCase[] = [
	{
		name: "an invocation identity is 13 digits of milliseconds, a hyphen and 16 hexadecimal digits; each attempt adds a dot and 8; the operation is given both",
		run: (h) => inCase(h, {}, async (c) => {
			const ending = await c.ended({ operation: "which" });
			check(INVOCATION_PATTERN.test(ending.invocation), `an invocation identity as EM11 writes it, not ${ending.invocation}`);
			check(isAttemptId(ending.attempt) && ending.attempt.startsWith(`${ending.invocation}.`), "an attempt identity holding the invocation");
			if (ending.ending === "answered") same(ending.answer, { host: c.a.nodeId, invocation: ending.invocation, attempt: ending.attempt }, "the operation was given the invocation and the attempt");
			const other = await c.ended({ operation: "which" });
			check(other.invocation !== ending.invocation, "a new invocation has a new identity");
		}),
	},
	{
		name: "a repeated invocation carries the same identity to the operation, under a new attempt identity",
		run: (h) => inCase(h, {}, async (c) => {
			const first = await c.ended({ operation: "which" });
			const again = await c.ended({ operation: "which", invocation: first.invocation, repeat: true });
			same(again.ending, "answered", "the repeat is answered");
			same(c.a.runs.map((r) => r.invocation), [first.invocation, first.invocation], "the operation saw one invocation identity twice");
			check(c.a.runs[0]?.attempt !== c.a.runs[1]?.attempt, "each attempt had its own identity");
		}),
	},
];

export const instanceSelectCases: readonly SuiteCase[] = [
	{
		name: "a call pinned to a named host never reaches the other host advertising the same operation",
		run: (h) => inCase(h, {}, async (c) => {
			for (let i = 0; i < 5; i++) {
				const ending = await c.ended({ operation: "which", host: c.b.nodeId });
				if (ending.ending === "answered") same((ending.answer as { host: string }).host, c.b.nodeId, "answered by the named host");
				else same(ending.ending, "answered", "the ending");
			}
			same(c.a.runs.length, 0, "the other advertiser never ran");
			const toA = await c.ended({ operation: "which", host: c.a.nodeId });
			if (toA.ending === "answered") same((toA.answer as { host: string }).host, c.a.nodeId, "answered by the named host");
			same(c.b.runs.length, 5, "a call pinned to the first host never reached the second");
		}),
	},
	{
		name: "a call pinned to an unavailable named host is refused by AGP, not delivered, and no host handles it",
		run: (h) => inCase(h, {}, async (c) => {
			const ending = await untilEndedPumping(c, watch(c.call({ operation: "which", host: "fixture-absent-node" })), "a pin to an absent host");
			checkNotDelivered(ending, ["INSTANCE_UNREACHABLE", "NO_ROUTE"], false, "a pin to an absent host");
			same(c.a.runs.length + c.b.runs.length, 0, "no host handled it");
		}),
	},
	{
		name: "an operation no host declares has no endpoint, so AGP refuses the call before any handler runs",
		run: (h) => inCase(h, {}, async (c) => {
			checkNotDelivered(await c.ended({ operation: "undeclared", host: c.a.nodeId }), ["NO_ROUTE"], false, "an undeclared operation");
			same(c.a.runs.length + c.b.runs.length, 0, "no handler ran");
		}),
	},
];
