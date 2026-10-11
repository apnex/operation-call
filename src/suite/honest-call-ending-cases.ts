/**
 * honest-call-ending: every invocation ends exactly once, answered, refused, not delivered or unknown, and
 * the first event decides (zorg's target, EM11 and EM12; zorg's E6).
 */
import type { CallEnding } from "../call-types.js";
import { isAttemptId, isInvocationId } from "../names.js";
import { check, same, settle, until, watch } from "./suite-check.js";
import { beneathBound, checkAtBound, checkNotDelivered, inCase, runOutBound, untilEndedPumping } from "./suite-support.js";
import type { SuiteCase } from "./suite-types.js";

/** An array nested `levels` deep around 0. */
function nested(levels: number): unknown {
	let value: unknown = 0;
	for (let i = 0; i < levels; i++) value = [value];
	return value;
}

export const honestCallEndingCases: readonly SuiteCase[] = [
	{
		name: "an invocation the operation answers ends answered, exactly once, with the answer unchanged",
		run: (h) => inCase(h, {}, async (c) => {
			const input = { text: "caf\u00e9", list: [1, 2.5, -3, null, true], nested: { empty: {}, none: [] } };
			const call = watch(c.call({ operation: "echo", input }));
			await until(call.settled, "the ending");
			const ending = call.value() as CallEnding;
			same(ending.ending, "answered", "the ending");
			if (ending.ending === "answered") same(ending.answer, input, "the answer, unchanged");
			same(ending.operation, "echo", "the operation's name");
			check(isInvocationId(ending.invocation) && isAttemptId(ending.attempt) && ending.attempt.startsWith(`${ending.invocation}.`), "the ending names its invocation and attempt");
			c.hooks.advanceCallClock(5000);
			c.hooks.advanceAgpClock(0);
			await settle();
			same(call.count(), 1, "one ending");
			same(call.value(), ending, "the ending unchanged");
		}),
	},
	{
		name: "an operation that throws ends the invocation unknown with reason operation-failed and no AGP code",
		run: (h) => inCase(h, {}, async (c) => {
			const call = watch(c.call({ operation: "throws" }));
			await until(call.settled, "the ending");
			const ending = call.value() as CallEnding;
			same(ending.ending, "unknown", "the ending");
			if (ending.ending !== "unknown") return;
			same(ending.reason, "operation-failed", "the reason");
			same(ending.agpCode, null, "no AGP code");
			check(ending.deliveryReport === null || ending.deliveryReport === "delivered", "the delivery report is the last one AGP gave, if any");
			same(c.a.runs.length, 1, "the operation ran once");
		}),
	},
	{
		name: "an answer of exactly 30 levels, the message counted, is answered; one level more ends unknown with answer-not-sendable and no AGP code",
		run: (h) => inCase(h, {}, async (c) => {
			const input = nested(29);
			const fits = watch(c.call({ operation: "echo", input: input as never }));
			await until(fits.settled, "the 30-level answer");
			same(fits.value()?.ending, "answered", "an end message of 30 levels crosses AGP");
			const deeper = watch(c.call({ operation: "deeper", input: input as never }));
			await until(deeper.settled, "the 31-level answer's ending");
			const ending = deeper.value() as CallEnding;
			same(ending.ending, "unknown", "the ending");
			if (ending.ending !== "unknown") return;
			same(ending.reason, "answer-not-sendable", "the reason");
			same(ending.agpCode, null, "the host found the answer unsendable itself");
		}),
	},
	{
		name: "an answer larger than the caller's receive limit ends unknown with answer-not-sendable and AGP's MESSAGE_TOO_LARGE",
		run: (h) => inCase(h, {}, async (c) => {
			const call = watch(c.call({ operation: "sized", input: { bytes: 2_000_000 } }));
			await until(call.settled, "the ending");
			const ending = call.value() as CallEnding;
			same(ending.ending, "unknown", "the ending");
			if (ending.ending !== "unknown") return;
			same(ending.reason, "answer-not-sendable", "the reason");
			same(ending.agpCode, "MESSAGE_TOO_LARGE", "AGP's code, unchanged");
			const after = await c.ended({ operation: "echo", input: "after" });
			same(after.ending, "answered", "a call after it is answered");
		}),
	},
	{
		name: "each failure of AGP's becomes a not-delivered ending carrying AGP's code, never a refusal record",
		run: (h) => inCase(h, {}, async (c) => {
			const undeclared = await c.ended({ operation: "not-declared" });
			checkNotDelivered(undeclared, ["NO_ROUTE"], false, "an operation no host declares");
			const absent = await untilEndedPumping(c, watch(c.call({ operation: "which", host: "fixture-absent-node" })), "a pin to a node that does not exist");
			checkNotDelivered(absent, ["INSTANCE_UNREACHABLE", "NO_ROUTE"], false, "a pin to a node that does not exist");
			const controller = new AbortController();
			controller.abort();
			checkNotDelivered(await c.ended({ operation: "which", signal: controller.signal }), ["ABORTED"], false, "a signal aborted before the send");
			checkNotDelivered(await c.ended({ operation: "echo", input: "x".repeat(2_000_000) }), ["MESSAGE_TOO_LARGE"], false, "a request over the peer's receive limit");
			same(c.a.runs.length + c.b.runs.length, 0, "no operation ran");
		}),
	},
	{
		name: "with two clocks, AGP's admission deadline passing first ends not delivered with TIMEOUT, the call's bound passing later changes nothing, and the request never arrives",
		run: (h) => inCase(h, {}, async (c) => {
			const admission = beneathBound(c.harness, 100);
			const release = c.hooks.holdExecutor(c.session.callerNodeId);
			const call = watch(c.call({ operation: "which", bound: 100 }));
			await settle();
			check(!call.settled(), "the send waits behind the held executor");
			c.hooks.advanceAgpClock(admission - 1);
			await settle();
			check(!call.settled(), "AGP's admission deadline, the time the call beneath is given, has not yet passed");
			c.hooks.advanceAgpClock(1);
			await until(call.settled, "AGP's refusal");
			checkNotDelivered(call.value(), ["TIMEOUT"], false, "the admission deadline");
			c.hooks.advanceCallClock(100);
			await release();
			c.hooks.advanceAgpClock(0);
			await settle();
			same(call.count(), 1, "one ending");
			checkNotDelivered(call.value(), ["TIMEOUT"], false, "the ending after the bound");
			same(c.a.runs.length, 0, "the refused request never arrived after the queue drained");
		}),
	},
	{
		name: "with two clocks, the call's bound passing first ends unknown, AGP's deadline later changes nothing, and the request never arrives",
		run: (h) => inCase(h, {}, async (c) => {
			const release = c.hooks.holdExecutor(c.session.callerNodeId);
			const call = watch(c.call({ operation: "which", bound: 100 }));
			await settle();
			await runOutBound(c, call, 100, { waits: "the call waits until its bound", ending: "the ending at the bound" });
			checkAtBound(call.value(), null, "the bound, before the send settled");
			const ending = call.value();
			c.hooks.advanceAgpClock(100);
			await release();
			c.hooks.advanceAgpClock(0);
			await settle();
			same(call.count(), 1, "one ending");
			same(call.value(), ending, "AGP's later refusal changes nothing");
			same(c.a.runs.length, 0, "the request never arrived after the queue drained");
		}),
	},
	{
		name: "a deadline and a cancellation falling after admission has committed, before the receipt, yield the operation's answer",
		run: (h) => inCase(h, {}, async (c) => {
			const controller = new AbortController();
			c.hooks.afterNextAdmission(() => {
				controller.abort();
				c.hooks.advanceAgpClock(1000);
			});
			const ending = await c.ended({ operation: "which", bound: 1000, signal: controller.signal });
			same(ending.ending, "answered", "the answer, though the signal fired and AGP's deadline passed after admission");
		}),
	},
	{
		name: "a deadline and a cancellation falling after admission has committed, with no answer, end unknown at the bound, never not delivered",
		run: (h) => inCase(h, {}, async (c) => {
			const controller = new AbortController();
			c.hooks.afterNextAdmission(() => {
				controller.abort();
				c.hooks.advanceAgpClock(1000);
			});
			const call = watch(c.call({ operation: "silent", bound: 1000, signal: controller.signal }));
			await until(() => c.a.runs.length === 1, "the operation runs");
			await settle();
			check(!call.settled(), "nothing ends the call before its bound");
			await runOutBound(c, call, 1000, { ending: "the ending at the bound" });
			const report = c.hooks.reports().at(-1) ?? null;
			checkAtBound(call.value(), report === "failed" ? null : report, "an admitted send whose signal and deadline passed afterwards");
		}),
	},
];
