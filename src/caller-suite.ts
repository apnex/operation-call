/**
 * operation-call's caller contract suite, exported as `@apnex/operation-call/caller-suite` (operation-proxy's
 * PX10; zorg's E6 and E17): a function taking the consumer's test registration and a harness - which gives
 * each case the caller under test and the fixture's hooks: the call bound's clock, AGP's injected clock and
 * executor barrier, and the channel-loss hook - and registering every caller case of operation-call's
 * contract tests.
 *
 * operation-call's own contract tests run it directly against its own caller; operation-proxy runs it
 * against its client half, through its proxy, so the caller is any implementation of the caller interface.
 * The suite holds every case a caller can observe (zorg's target, EM12): invalid arguments, every ending's
 * exact fields and freezing, when an event happens on the call's clock, and remote descriptions included;
 * cases a caller cannot observe - malformed requests, evidence, declarations and E9's corpus - stay in
 * operation-call's own contract files. The harness states its hop allowance (zorg's D45): 0 for a direct
 * caller, and for a caller across a hop the allowance by which its far side's call ends sooner, so a case
 * whose call ends at its bound takes the ending the hop carries from the allowance's edge, `unknown` with
 * `bound-passed` and the call layer's delivery report, and never `hop-stalled`, and a case that depends on
 * the time the call beneath is given, such as its admission deadline, computes it as the bound less the
 * allowance (zorg's D46). Every case runs through both kinds of harness, none excluded; operation-proxy adds
 * its own cases of a hop held past the allowance. Nothing here is particular to one runtime (zorg's D31).
 */
import { callerChosenBoundCases, requestCorrelationCases } from "./suite/bound-and-correlation-cases.js";
import { boundArgumentCases, callArgumentCases, descriptionCases, identityArgumentCases, repeatArgumentCases } from "./suite/caller-observable-cases.js";
import { channelLossCases } from "./suite/channel-loss-cases.js";
import { eventTimeCases, preparationTimeCases } from "./suite/event-time-cases.js";
import { honestCallEndingCases } from "./suite/honest-call-ending-cases.js";
import { notDeliveredCases } from "./suite/not-delivered-cases.js";
import { callRefusalCases, instanceSelectCases, invocationIdentityCases } from "./suite/refusal-and-identity-cases.js";
import type { CallerSuiteHarness, SuiteCase, SuiteRegister } from "./suite/suite-types.js";

export type { CallerSuiteHarness, CallerSuiteHooks, CallerSuiteOpenOptions, CallerSuiteSession, SuiteHost, SuiteRegister } from "./suite/suite-types.js";

/** The caller cases of each contract row. */
const CASES: { readonly [row: string]: readonly SuiteCase[] } = {
	"honest-call-ending": [...honestCallEndingCases, ...eventTimeCases, ...channelLossCases, ...callArgumentCases],
	"caller-chosen-bound": [...callerChosenBoundCases, ...preparationTimeCases, ...boundArgumentCases],
	"invocation-identity": [...invocationIdentityCases, ...identityArgumentCases],
	"request-correlation": requestCorrelationCases,
	"not-delivered-signal": [...notDeliveredCases, ...repeatArgumentCases],
	"call-refusal": callRefusalCases,
	"operation-descriptions": descriptionCases,
	"advertiser-instance-select": instanceSelectCases,
};

/** The rows the suite holds caller cases for, and the rows deferred with the ruling that defers them. */
export const callerSuiteRows = Object.freeze({
	rows: Object.freeze(Object.keys(CASES)),
	deferred: Object.freeze({ "answer-in-parts": "D15", "cancel-invocation": "D15" }),
});

/**
 * Registers every caller case of the rows named - every row when none are named - with the consumer's
 * test runner, each run in a fresh session the harness opens. Every case is registered and none skipped;
 * returns how many were registered.
 */
export function registerCallerSuite(register: SuiteRegister, harness: CallerSuiteHarness, rows: readonly string[] = callerSuiteRows.rows): number {
	if (harness === null || typeof harness !== "object" || typeof harness.open !== "function") throw new TypeError("the caller suite needs a harness: { open, hopAllowanceMs }");
	if (!Number.isInteger(harness.hopAllowanceMs) || harness.hopAllowanceMs < 0) throw new RangeError("a harness states its hop allowance as a whole number of milliseconds from 0, 0 for a direct caller");
	let count = 0;
	for (const row of rows) {
		const cases = CASES[row];
		if (cases === undefined) throw new Error(`the caller suite has no row ${row}; its rows are ${callerSuiteRows.rows.join(", ")}`);
		for (const c of cases) {
			register(`${row}: ${c.name}`, () => c.run(harness));
			count++;
		}
	}
	return count;
}
