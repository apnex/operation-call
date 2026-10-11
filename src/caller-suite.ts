/**
 * operation-call's caller contract suite, exported as `@apnex/operation-call/caller-suite` (operation-proxy's
 * PX10; zorg's E6 and E17): a function taking the consumer's test registration and a harness - which gives
 * each case the caller under test and the fixture's hooks: the call bound's clock, AGP's injected clock and
 * executor barrier, and the channel-loss hook - and registering every caller case of operation-call's
 * contract tests.
 *
 * operation-call's own contract tests run it directly against its own caller; operation-proxy runs it
 * against its client half, through its proxy, so the caller is any implementation of the caller interface.
 * Nothing here is particular to one runtime (zorg's D31).
 */
import { callerChosenBoundCases, requestCorrelationCases } from "./suite/bound-and-correlation-cases.js";
import { channelLossCases } from "./suite/channel-loss-cases.js";
import { honestCallEndingCases } from "./suite/honest-call-ending-cases.js";
import { notDeliveredCases } from "./suite/not-delivered-cases.js";
import { callRefusalCases, instanceSelectCases, invocationIdentityCases } from "./suite/refusal-and-identity-cases.js";
import type { CallerSuiteHarness, SuiteCase, SuiteRegister } from "./suite/suite-types.js";

export type { CallerSuiteHarness, CallerSuiteHooks, CallerSuiteOpenOptions, CallerSuiteSession, SuiteHost, SuiteRegister } from "./suite/suite-types.js";

/** The caller cases of each contract row. */
const CASES: { readonly [row: string]: readonly SuiteCase[] } = {
	"honest-call-ending": [...honestCallEndingCases, ...channelLossCases],
	"caller-chosen-bound": callerChosenBoundCases,
	"invocation-identity": invocationIdentityCases,
	"request-correlation": requestCorrelationCases,
	"not-delivered-signal": notDeliveredCases,
	"call-refusal": callRefusalCases,
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
