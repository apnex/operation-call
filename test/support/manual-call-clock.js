// manual-call-clock - the call bound's clock under test control, apart from AGP's injected clock
// (zorg's target, EM12): time moves only when a test advances it, and every callback due by then runs, in
// the order it falls due.

export function createManualCallClock(start = 1_000_000) {
	let now = start;
	let nextId = 1;
	const tasks = [];
	return {
		now: () => now,
		schedule(delayMs, callback) {
			if (!Number.isFinite(delayMs) || delayMs < 0) throw new RangeError(`a delay of ${delayMs} ms`);
			const task = { id: nextId++, due: now + delayMs, callback, cancelled: false };
			tasks.push(task);
			return { cancel() { task.cancelled = true; } };
		},
		advance(ms) {
			if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`an advance of ${ms} ms`);
			const target = now + ms;
			for (;;) {
				const due = tasks.filter((t) => !t.cancelled && t.due <= target).sort((a, b) => a.due - b.due || a.id - b.id)[0];
				if (due === undefined) break;
				now = due.due;
				due.cancelled = true;
				due.callback();
			}
			now = target;
		},
		pending: () => tasks.filter((t) => !t.cancelled).length,
	};
}
