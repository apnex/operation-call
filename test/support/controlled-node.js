// controlled-node - an object with the AgpNode surface a caller uses, whose every answer the test gives
// when it chooses: the send's receipt or rejection, the disposition and its settling, and messages to the
// reply endpoint. With the manual call clock's `move`, which holds the bound's callback back, it places an
// observation of AGP or of the reply endpoint after the bound has passed on the call's clock, before the
// bound's callback runs (zorg's target, EM12). Behaviour over AGP itself is tested on the production carrier.
import { createCaller } from "@apnex/operation-call";
import { writeEnd } from "@apnex/operation-call/message-format";
import { createManualCallClock } from "./manual-call-clock.js";

/** A caller over a controlled node, on a manual call clock starting at 0, with a counter for identities. */
export async function controlledCaller({ clock = createManualCallClock(0), identities } = {}) {
	const sends = [];
	let handler;
	let report;
	const settling = Promise.withResolvers();
	let n = 0;
	const node = {
		async expose(_endpoint, h) { handler = h; return { close: async () => {} }; },
		send(source, destination, payload, options) {
			const outcome = Promise.withResolvers();
			sends.push({ source, destination, payload, options, outcome });
			return outcome.promise;
		},
		disposition: () => report,
		settled: () => settling.promise,
	};
	const caller = await createCaller({ node, clock, identities: identities ?? { wallTimeMs: () => 1791540000000, randomHex: (d) => (++n).toString(16).padStart(d, "0") } });
	return {
		caller, clock, sends,
		/** The send AGP is asked for last, as the caller wrote it. */
		last: () => sends.at(-1),
		/** Admits the last send, with the disposition it reports at once. */
		admit(disposition) { report = disposition; sends.at(-1).outcome.resolve({ messageId: "m1" }); },
		/** Rejects the last send with an error carrying `code`, or none when it is undefined. */
		reject(code) { sends.at(-1).outcome.reject(code === undefined ? new Error("no code") : Object.assign(new Error(code), { code })); },
		/** Settles the disposition with these outcomes. */
		settle(outcomes) { report = { outcomes }; settling.resolve(report); },
		/** Delivers an end message for the last send to the reply endpoint, as from its host's operation endpoint. */
		async reply(content) {
			const { payload, destination, options } = sends.at(-1);
			const address = { invocation: payload.invocation, attempt: payload.attempt, operation: payload.operation };
			await handler(writeEnd(address, content), { delivery: { correlationId: payload.attempt, source: { endpoint: destination, originNodeId: options.destinationSelector.originNodeId } } });
		},
	};
}

/** Turns of the event loop, so every reaction the last step started has run. */
export async function turns(n = 10) {
	for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
}
