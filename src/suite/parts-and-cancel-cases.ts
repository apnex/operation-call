/**
 * The caller suite's cases of answers in parts and of cancelling (zorg's target, EM11, EM12; zorg's D64): what a
 * caller can observe of parts given to `onPart`, its bound on signs of life, the `alive` it submits, a missing
 * part, and the `cancel` an abort submits. Each case runs against the fixture hosts, whose operations `stream`,
 * `quiet` and `drip` answer in parts, and against `fixture/scripted`, which answers with exactly the messages a
 * case scripts and records what reaches it - so a case sees the caller's `alive` and `cancel`. A case whose call
 * ends at its deadline takes a hop's allowance as `runOutBound` does: nothing may end before the allowance's
 * edge, and the ending is `bound-passed`.
 */
import type { AnswerPart, CallEnding, CallRequest } from "../call-types.js";
import type { JsonValue } from "@apnex/shape-check";
import { check, same, settle, until, watch, type Watched } from "./suite-check.js";
import { checkEndingFields, discardedCount, hopAllowance, inCase, SCRIPTED, type CaseContext } from "./suite-support.js";
import type { SuiteCase } from "./suite-types.js";

/** A call accepting parts: its ending watched, and every part given to `onPart`, in order. */
interface PartsCall {
	readonly call: Watched<CallEnding>;
	readonly parts: AnswerPart[];
	/** How many parts `onPart` had been given when the ending settled. */
	readonly partsAtEnding: () => number | undefined;
}

/** Invokes with an `onPart` that collects every part. */
function partsCall(c: CaseContext, request: Partial<CallRequest> & { readonly operation: string }, onPart?: (part: AnswerPart) => unknown): PartsCall {
	const parts: AnswerPart[] = [];
	let atEnding: number | undefined;
	const call = watch(c.call({ ...request, onPart: (part) => { parts.push(part); return onPart?.(part); } }).then((ending) => { atEnding = parts.length; return ending; }));
	return { call, parts, partsAtEnding: () => atEnding };
}

/** The messages of one type that reached `fixture/scripted` on host `a` under an attempt, or under any. */
function scriptedOf(c: CaseContext, type: string, attempt?: string): number {
	return c.a.scripted.filter((m) => m.type === type && (attempt === undefined || m.attempt === attempt)).length;
}

/** The attempt of the last request that reached `fixture/scripted` on host `a`. */
function scriptedAttempt(c: CaseContext): string | undefined {
	return c.a.scripted.filter((m) => m.type === "request").at(-1)?.attempt;
}

/** A scripted part. */
const part = (sequence: number, answer: JsonValue): JsonValue => ({ type: "part", sequence, answer });
/** A scripted end, answered, with `parts` when given. */
const answeredEnd = (answer: JsonValue, parts?: number): JsonValue => ({ type: "end", outcome: "answered", answer, ...(parts === undefined ? {} : { parts }) });
const WAIT: JsonValue = { wait: true };
const ALIVE: JsonValue = { type: "alive" };

/** True when a value and everything in it is frozen. */
function deeplyFrozen(value: unknown): boolean {
	if (value === null || typeof value !== "object") return true;
	if (!Object.isFrozen(value)) return false;
	return Object.values(value as object).every(deeplyFrozen);
}

/**
 * Advances the call bound's clock to just short of `deadline`'s allowance edge, checking nothing has ended, then
 * to the deadline, waiting for the call to end at its bound; `now` is the clock's time relative to the call.
 */
async function runOutDeadline(c: CaseContext, call: Watched<CallEnding>, now: number, deadline: number, bound: number, what: string): Promise<CallEnding | undefined> {
	const edge = deadline - hopAllowance(c.harness, bound);
	c.hooks.advanceCallClock(edge - 1 - now);
	await settle();
	check(!call.settled(), `${what}: nothing ends before the deadline's edge`);
	c.hooks.advanceCallClock(deadline - (edge - 1));
	await until(call.settled, `${what}: the call ends at its deadline`);
	const ending = call.value();
	same([ending?.ending, ending?.ending === "unknown" ? ending.reason : undefined], ["unknown", "bound-passed"], `${what}: unknown at its deadline`);
	return ending;
}

export const answerInPartsCases: SuiteCase[] = [
	{
		name: "parts are given to onPart in order and synchronously, each deeply frozen, before the end that counts them decides the ending",
		run: (h) => inCase(h, {}, async (c) => {
			const answers: JsonValue[] = ["a", { b: [1, { c: true }] }, 3];
			const p = partsCall(c, { operation: "stream", input: { parts: answers } });
			await until(p.call.settled, "the call answering in parts ends");
			const ending = p.call.value();
			checkEndingFields(ending, "an answer in parts");
			same(ending?.ending === "answered" ? ending.answer : ending, { sent: 3, results: [true, true, true] }, "answered, every part admitted");
			same(p.parts.map((x) => [x.sequence, x.answer]), answers.map((a, i) => [i + 1, a]), "each part, in order, from 1");
			same(p.partsAtEnding(), 3, "every part given to onPart before the ending");
			check(p.parts.every(deeplyFrozen), "each part given to onPart is deeply frozen");
		}),
	},
	{
		name: "a whole operation called with onPart is answered with no part; an operation in parts called without it is answered, its parts discarded",
		run: (h) => inCase(h, {}, async (c) => {
			const whole = partsCall(c, { operation: "which" });
			await until(whole.call.settled, "the whole operation called with onPart ends");
			same(whole.call.value()?.ending, "answered", "a whole operation, its end counting no part");
			same(whole.parts.length, 0, "no part");
			const before = discardedCount(c);
			const ending = await c.ended({ operation: "stream", input: { parts: ["x", "y"] } });
			same(ending.ending === "answered" ? ending.answer : ending, { sent: 2, results: [true, true] }, "answered: the host sent both parts, admitted");
			const after = discardedCount(c);
			if (before !== undefined && after !== undefined) same(after - before, 2, "both parts discarded and counted by a caller that takes none");
		}),
	},
	{
		name: "the bound is a bound on signs of life: each part taken moves the deadline a bound on, and with no more the call ends a bound after the last, then submits one cancel",
		run: (h) => inCase(h, {}, async (c) => {
			const bound = 1000;
			const p = partsCall(c, { operation: SCRIPTED, bound, input: { messages: [WAIT, part(1, "one"), WAIT, part(2, "two"), WAIT] } });
			await until(() => c.a.holds.length === 1, "the scripted host waits");
			c.hooks.advanceCallClock(600);
			c.a.holds[0]?.release();
			await until(() => p.parts.length === 1, "the first part taken at 600");
			c.hooks.advanceCallClock(900);
			await settle();
			check(!p.call.settled(), "at 1500, past the first bound, the call goes on: the part at 600 moved its deadline to 1600");
			await until(() => c.a.holds.length === 2, "the scripted host waits again");
			c.a.holds[1]?.release();
			await until(() => p.parts.length === 2, "the second part taken at 1500");
			const attempt = scriptedAttempt(c);
			await runOutDeadline(c, p.call, 1500, 2500, bound, "a bound after the last part");
			same(p.parts.map((x) => x.answer), ["one", "two"], "the parts taken stand");
			await until(() => scriptedOf(c, "cancel", attempt) === 1, "one cancel, the call having ended at its deadline");
			await settle();
			same(scriptedOf(c, "cancel", attempt), 1, "only one cancel");
		}),
	},
	{
		name: "a host's alive is a sign of life: a quiet operation in parts is kept alive past several bounds",
		run: (h) => inCase(h, {}, async (c) => {
			const controller = new AbortController();
			const p = partsCall(c, { operation: "quiet", bound: 1000, signal: controller.signal });
			await until(() => c.a.runs.length === 1, "the quiet operation runs");
			for (let step = 0; step < 8; step++) {
				c.hooks.advanceCallClock(250);
				await settle();
			}
			check(!p.call.settled(), "after 2000 ms, twice the bound, the host's alive kept the call alive");
			controller.abort();
			await until(p.call.settled, "the cancelled call ends");
			same(p.call.value()?.ending === "answered" ? p.call.value() && (p.call.value() as { answer: JsonValue }).answer : p.call.value(), { cancelled: true }, "answered as the cancelled operation answers");
		}),
	},
	{
		name: "a caller accepting parts submits alive to the host as it waits, and one that does not submits none",
		run: (h) => inCase(h, {}, async (c) => {
			const bound = 3000;
			const p = partsCall(c, { operation: SCRIPTED, bound, input: { messages: [WAIT] } });
			await until(() => c.a.holds.length === 1, "the scripted host has the request");
			const attempt = scriptedAttempt(c);
			const edge = bound - hopAllowance(c.harness, bound);
			c.hooks.advanceCallClock(edge - 1);
			await until(() => scriptedOf(c, "alive", attempt) >= 1, "an alive from the caller before its deadline");
			check(!p.call.settled(), "the caller's own alive moves nothing of its deadline");
			c.hooks.advanceCallClock(bound - (edge - 1));
			await until(p.call.settled, "the call ends at its bound");
			c.a.holds[0]?.release();
			const whole = watch(c.call({ operation: SCRIPTED, bound, input: { messages: [WAIT] } }));
			await until(() => c.a.holds.length === 2, "the scripted host has the second request");
			const second = scriptedAttempt(c);
			c.hooks.advanceCallClock(bound);
			await until(whole.settled, "the call accepting no parts ends at its bound");
			c.a.holds[1]?.release();
			await settle();
			same([scriptedOf(c, "alive", second), scriptedOf(c, "cancel", second)], [0, 0], "no alive and no cancel from a call accepting no parts");
		}),
	},
	{
		name: "a part whose sequence is lower is discarded and the call goes on; one whose sequence is higher ends it unknown with part-missing, the parts taken standing, and submits one cancel",
		run: (h) => inCase(h, {}, async (c) => {
			const p = partsCall(c, { operation: SCRIPTED, input: { messages: [part(1, "one"), part(1, "again"), part(3, "three")] } });
			await until(p.call.settled, "the call ends");
			const ending = p.call.value();
			checkEndingFields(ending, "a missing part");
			same([ending?.ending, ending?.ending === "unknown" ? ending.reason : undefined, ending?.ending === "unknown" ? ending.agpCode : undefined], ["unknown", "part-missing", null], "unknown with part-missing");
			same(p.parts.map((x) => [x.sequence, x.answer]), [[1, "one"]], "the part taken stands, its repeat discarded");
			const attempt = scriptedAttempt(c);
			await until(() => scriptedOf(c, "cancel", attempt) === 1, "one cancel after part-missing");
		}),
	},
	{
		name: "an end whose parts is not the number of parts taken ends the call part-missing; an end holding no parts for a call accepting them is discarded",
		run: (h) => inCase(h, {}, async (c) => {
			for (const [count, what] of [[2, "above"], [0, "below"]] as const) {
				const p = partsCall(c, { operation: SCRIPTED, input: { messages: [part(1, "one"), answeredEnd("done", count)] } });
				await until(p.call.settled, `an end counting ${what} the parts taken`);
				const ending = p.call.value();
				same([ending?.ending, ending?.ending === "unknown" ? ending.reason : undefined], ["unknown", "part-missing"], `an end counting ${what} the parts taken`);
			}
			const counted = partsCall(c, { operation: SCRIPTED, input: { messages: [part(1, "one"), answeredEnd("done", 1)] } });
			await until(counted.call.settled, "an end counting the parts taken");
			same(counted.call.value()?.ending === "answered" ? (counted.call.value() as { answer: JsonValue }).answer : counted.call.value(), "done", "the end counting them decides");
			const bound = 1000;
			const uncounted = partsCall(c, { operation: SCRIPTED, bound, input: { messages: [answeredEnd("done")] } });
			await until(() => scriptedOf(c, "request") === 4, "the fourth request reaches the scripted host");
			await settle();
			check(!uncounted.call.settled(), "an end holding no parts is not taken");
			await runOutDeadline(c, uncounted.call, 0, bound, bound, "a call whose only end was discarded");
		}),
	},
	{
		name: "what onPart returns or throws changes nothing, and leaves no rejection unhandled",
		run: (h) => inCase(h, {}, async (c) => {
			const throwing = partsCall(c, { operation: "stream", input: { parts: [1, 2] } }, () => { throw new Error("onPart throws"); });
			await until(throwing.call.settled, "the call whose onPart throws ends");
			same(throwing.call.value()?.ending, "answered", "answered though onPart threw");
			same(throwing.parts.length, 2, "every part still given");
			const rejecting = partsCall(c, { operation: "stream", input: { parts: [1, 2] } }, () => Promise.reject(new Error("onPart rejects")));
			await until(rejecting.call.settled, "the call whose onPart rejects ends");
			same(rejecting.call.value()?.ending, "answered", "answered though onPart's promise rejected");
			await settle();
			same(c.hooks.unhandled().length, 0, "no rejection or exception left unhandled");
		}),
	},
];

export const cancelInvocationCases: SuiteCase[] = [
	{
		name: "an abort after admission submits one cancel, which fires the operation's signal, and the call ends as the operation then ends",
		run: (h) => inCase(h, {}, async (c) => {
			const controller = new AbortController();
			const p = partsCall(c, { operation: "quiet", bound: 1000, signal: controller.signal });
			await until(() => c.a.runs.length === 1, "the quiet operation runs");
			const attempt = c.a.runs[0]?.attempt as string;
			controller.abort();
			await until(() => c.a.aborted.includes(attempt), "the operation's signal fires");
			await until(p.call.settled, "the cancelled call ends");
			same(p.call.value()?.ending === "answered" ? (p.call.value() as { answer: JsonValue }).answer : p.call.value(), { cancelled: true }, "the operation's answer once cancelled");
		}),
	},
	{
		name: "a cancelled call ends within one bound of its last sign of life before the abort, though the host keeps sending alive, and submits one cancel only",
		run: (h) => inCase(h, {}, async (c) => {
			const bound = 1000;
			const controller = new AbortController();
			const p = partsCall(c, { operation: SCRIPTED, bound, signal: controller.signal, input: { messages: [WAIT, ALIVE, WAIT, ALIVE, WAIT] } });
			await until(() => c.a.holds.length === 1, "the scripted host has the request");
			const attempt = scriptedAttempt(c);
			c.hooks.advanceCallClock(400);
			c.a.holds[0]?.release();
			await until(() => c.a.holds.length === 2, "the host's alive at 400 sent");
			await settle();
			c.hooks.advanceCallClock(100);
			controller.abort();
			await until(() => scriptedOf(c, "cancel", attempt) === 1, "the cancel reaches the host");
			c.hooks.advanceCallClock(400);
			c.a.holds[1]?.release();
			await until(() => c.a.holds.length === 3, "the host's alive at 900 sent, after the cancel");
			await settle();
			await runOutDeadline(c, p.call, 900, 1400, bound, "a cancelled call, its deadline fixed by the abort at 1400");
			await settle();
			same(scriptedOf(c, "cancel", attempt), 1, "one cancel, though the call then ended at its deadline");
		}),
	},
	{
		name: "an abort before the request is sent ends the call not delivered and submits no cancel; an abort once the call has ended changes nothing",
		run: (h) => inCase(h, {}, async (c) => {
			const aborted = new AbortController();
			aborted.abort();
			const before = c.a.scripted.length;
			const ending = await c.ended({ operation: SCRIPTED, onPart: () => undefined, signal: aborted.signal, input: { messages: [answeredEnd("done", 0)] } });
			same(ending.ending, "not-delivered", "not delivered");
			await settle();
			same(c.a.scripted.length, before, "nothing reached the host, no cancel among it");
			const controller = new AbortController();
			const p = partsCall(c, { operation: SCRIPTED, signal: controller.signal, input: { messages: [answeredEnd("done", 0)] } });
			await until(p.call.settled, "the call ends");
			same(p.call.value()?.ending, "answered", "answered");
			const attempt = scriptedAttempt(c);
			controller.abort();
			await settle();
			same(scriptedOf(c, "cancel", attempt), 0, "an abort after the ending submits no cancel");
		}),
	},
];
