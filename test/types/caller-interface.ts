// caller-interface - a compile-time consumer of the caller interface (zorg's target, EM12; operation-proxy's
// caller-interface-parity). Compiled by `npm test` with the package's own strict settings, emitting nothing:
// it passes when it compiles. It imports the package by its public name, so it reads what a consumer reads.
//
// A strict TypeScript function written against OperationCaller accepts operation-call's own caller unchanged,
// and accepts a caller across a hop giving the endings EM12 admits: attempt null, a proxy code, and the reasons
// a hop adds. operation-call's own caller gives only the call layer's endings, none of those additions.
import { createCaller, type Caller, type CallEnding, type CallLayerEnding, type CallRequest, type HopNotDeliveredEnding, type HopUnknownEnding, type OperationCaller } from "@apnex/operation-call";

/** True only when two types are the same type. */
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
/** Compiles only when given true. */
const holds = <T extends true>(): T | undefined => undefined;

/** A consumer written against the interface alone: it reads every ending EM12 names, exhaustively. */
async function describe(caller: OperationCaller, call: CallRequest): Promise<string> {
	const ending: CallEnding = await caller.invoke(call);
	const attempt: string = ending.attempt ?? "no attempt of the call layer";
	switch (ending.ending) {
		case "answered": return `${attempt} answered ${JSON.stringify(ending.answer)}`;
		case "refused": return `${attempt} refused ${ending.refusal.code}`;
		case "not-delivered": return `${attempt} not delivered: ${ending.agpCode ?? ending.proxyCode}`;
		case "unknown": return `${attempt} unknown: ${ending.reason}, ${ending.agpCode ?? "no AGP code"}, ${ending.deliveryReport ?? "no report"}`;
		default: {
			const none: never = ending;
			return none;
		}
	}
}

/** operation-call's own caller, as createCaller gives it, is accepted unchanged. */
export async function ownCaller(options: Parameters<typeof createCaller>[0], call: CallRequest): Promise<string> {
	const caller = await createCaller(options);
	return describe(caller, call);
}

/** A caller across a hop, giving each addition EM12 admits, is accepted unchanged. */
export function hopCaller(call: CallRequest): Promise<string> {
	const stalled: HopUnknownEnding = { ending: "unknown", invocation: "0000000000000-0000000000000000", attempt: null, operation: "echo", reason: "hop-stalled", agpCode: null, deliveryReport: null };
	const lost: CallEnding = { ...stalled, reason: "proxy-lost" };
	const passed: HopNotDeliveredEnding = { ending: "not-delivered", invocation: stalled.invocation, attempt: null, operation: "echo", agpCode: null, proxyCode: "deadline-passed", earlierAttemptsUncertain: false };
	const endings: readonly CallEnding[] = [stalled, lost, passed];
	const across: OperationCaller = { invoke: async () => endings[0] ?? passed };
	return describe(across, call);
}

// operation-call's own caller gives exactly the call layer's endings, and they are among the interface's.
holds<Same<Awaited<ReturnType<Caller["invoke"]>>, CallLayerEnding>>();
holds<CallLayerEnding extends CallEnding ? true : false>();
holds<Caller extends OperationCaller ? true : false>();
// None of the additions is a call layer ending: no null attempt, no proxy code, no reason a hop adds.
holds<Same<Extract<CallLayerEnding, { readonly attempt: null }>, never>>();
holds<Same<Extract<CallLayerEnding, { readonly proxyCode: string }>, never>>();
holds<Same<Extract<CallLayerEnding, { readonly reason: "proxy-lost" | "hop-stalled" }>, never>>();
// @ts-expect-error a hop's ending is not one operation-call's own caller gives
export const notOwn: CallLayerEnding = { ending: "unknown", invocation: "0000000000000-0000000000000000", attempt: null, operation: "echo", reason: "hop-stalled", agpCode: null, deliveryReport: null };
