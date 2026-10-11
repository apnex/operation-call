// fake-node - an object with the AgpNode surface a caller uses, recording what the caller asks of AGP, for
// cases about the arguments a caller passes AGP (zorg's target, EM12) that the production carrier cannot
// show: the admission deadline when time passes between invoking and sending, and the options of a send.
// Every behaviour about endings is tested on AGP's production in-process carrier instead.

export function createFakeNode({ reject = { code: "NO_ROUTE" } } = {}) {
	const sends = [];
	const exposed = new Map();
	return {
		nodeId: "fake",
		sends,
		exposed,
		async expose(endpoint, handler) {
			exposed.set(endpoint, handler);
			return { info: { endpoint }, close: async () => { exposed.delete(endpoint); } };
		},
		async send(source, destination, payload, options) {
			sends.push({ source, destination, payload, options });
			throw Object.assign(new Error("refused by the fake node"), reject);
		},
		disposition: () => undefined,
		settled: async () => undefined,
		dispositions: () => ({ close() {}, async *[Symbol.asyncIterator]() {} }),
	};
}

/** A call clock whose reading moves forward by `step` milliseconds at every read, and never calls back. */
export function createCreepingClock(step, start = 0) {
	let now = start;
	return {
		now: () => { const t = now; now += step; return t; },
		schedule: () => ({ cancel() {} }),
	};
}
