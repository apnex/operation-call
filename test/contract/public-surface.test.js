// public-surface - the package exposes exactly what export-map.json names (zorg's target, EM14; E12).
//
// Every path in package.json's exports is named in the map; each module path is imported by its public name
// and its runtime exports compared with the map; every capability row of CONTRACT.md is served by some export
// or deferred with a ruling, and every row of operation-call that zorg's Delta 1 fences is served. The caller
// half runs in a client, so the source imports no module particular to one runtime outside a file whose name
// ends -adapter.ts and uses no global particular to Node (principle 6; D31); AGP reaches it as types only;
// and only the file of default ports reads a clock or randomness itself.
import assert from "node:assert/strict";
import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const map = JSON.parse(fs.readFileSync(path.join(root, "export-map.json"), "utf8"));
const publicName = (p) => p === "." ? pkg.name : `${pkg.name}/${p.slice(2)}`;
const FENCED = ["honest-call-ending", "caller-chosen-bound", "invocation-identity", "request-correlation", "not-delivered-signal", "call-refusal", "operation-descriptions", "declared-shape-validation", "serve-named-operations", "peer-identity-evidence", "advertiser-instance-select"];

test("the export map names the package and exactly its exported paths", () => {
	assert.equal(map.package, pkg.name);
	assert.deepEqual(Object.keys(map.paths).sort(), Object.keys(pkg.exports).sort());
});

for (const [p, entry] of Object.entries(map.paths)) {
	test(`${publicName(p)} exposes what the map names`, async () => {
		assert.ok(entry.exports, `${p} names no exports`);
		const mod = await import(publicName(p));
		assert.deepEqual(Object.keys(mod).sort(), Object.keys(entry.exports).sort());
		for (const [name, use] of Object.entries(entry.exports)) {
			assert.equal(use.part, "operation-call", `${name} realises the operation-call part`);
			assert.ok(Array.isArray(use.serves) && use.serves.length > 0, `${name} serves at least one row`);
		}
	});
}

const contractRows = () => {
	const lines = fs.readFileSync(path.join(root, "CONTRACT.md"), "utf8").split("\n");
	const start = lines.findIndex((l) => /^\|\s*Capability\s*\|\s*Relation\s*\|/.test(l));
	const rows = [];
	for (let i = start + 2; start >= 0 && lines[i]?.startsWith("|"); i++) rows.push(lines[i].split("|")[1].trim().replaceAll("`", ""));
	return rows;
};

test("every contract row is served by an export or deferred with a ruling, never both; every fenced row is served", () => {
	const rows = contractRows();
	const served = new Set(Object.values(map.paths).flatMap((e) => Object.values(e.exports)).flatMap((x) => x.serves));
	for (const row of rows) assert.ok(served.has(row) || map.deferred[row], `${row} is neither served nor deferred`);
	for (const row of served) assert.ok(rows.includes(row), `${row} is not a row of CONTRACT.md`);
	for (const [row, ruling] of Object.entries(map.deferred)) {
		assert.match(ruling, /^D\d+$/, `${row} is deferred without a ruling`);
		assert.ok(!served.has(row), `${row} is both served and deferred`);
		assert.ok(rows.includes(row), `${row} is not a row of CONTRACT.md`);
	}
	for (const row of FENCED) assert.ok(served.has(row) && !map.deferred[row], `the fenced row ${row} is served`);
	assert.deepEqual(Object.keys(map.deferred).sort(), ["answer-in-parts", "cancel-invocation"], "only the rows D15 leaves out are deferred");
});

test("every fenced row has a contract test file named for it", () => {
	for (const row of FENCED) assert.ok(fs.existsSync(path.join(root, "test", "contract", `${row}.test.js`)), `${row}.test.js`);
});

test("the caller suite lists its rows and the deferred ones as the map does", async () => {
	const { callerSuiteRows } = await import(`${pkg.name}/caller-suite`);
	assert.deepEqual([...callerSuiteRows.rows].sort(), [...map.paths["./caller-suite"].exports.registerCallerSuite.serves].sort());
	assert.deepEqual({ ...callerSuiteRows.deferred }, map.deferred);
});

const sources = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? sources(path.join(dir, d.name)) : [path.join(dir, d.name)]);
const tsSources = () => sources(path.join(root, "src")).filter((f) => f.endsWith(".ts"));
const imports = (text) => [...text.matchAll(/\bimport\s+(type\s+)?[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']|\bexport\s+(type\s+)?[^;]*?\bfrom\s*["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']/g)]
	.map((m) => ({ typeOnly: Boolean(m[1] || m[4]), specifier: m[2] ?? m[3] ?? m[5] ?? m[6] }));
// Source with its comments removed, so prose about a process or a clock is not mistaken for code.
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");
const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

test("no source file imports a module particular to one runtime outside a file whose name ends -adapter.ts, or uses a global particular to Node", () => {
	const files = tsSources();
	assert.ok(files.length > 10);
	for (const file of files) {
		if (file.endsWith("-adapter.ts")) continue;
		const text = fs.readFileSync(file, "utf8");
		const runtime = imports(text).map((i) => i.specifier).filter((s) => s.startsWith("node:") || builtins.has(s));
		assert.deepEqual(runtime, [], `${path.relative(root, file)} imports ${runtime.join(", ")}`);
		assert.doesNotMatch(code(text), /\b(process|Buffer|__dirname|__filename|setImmediate)\b|\brequire\s*\(/, `${path.relative(root, file)} uses a global particular to Node`);
	}
});

test("AGP reaches the source as types only, so nothing of AGP's runtime is loaded with the caller or host", () => {
	for (const file of tsSources()) {
		for (const { typeOnly, specifier } of imports(fs.readFileSync(file, "utf8"))) {
			if (specifier.startsWith("@agp/")) assert.ok(typeOnly, `${path.relative(root, file)} imports ${specifier} at run time`);
		}
	}
});

test("only the file of default ports reads a clock or randomness; everything else takes them through the ports", () => {
	for (const file of tsSources()) {
		const text = code(fs.readFileSync(file, "utf8"));
		const reads = /Date\.now\s*\(|new Date\s*\(\s*\)|performance\.now|Temporal\.Now|Math\.random|getRandomValues/.test(text);
		if (path.basename(file) === "system-ports.ts") assert.ok(reads, "the default ports read the system clock and randomness");
		else assert.equal(reads, false, `${path.relative(root, file)} reads a clock or randomness`);
	}
});

test("the package depends on AGP's node and on shape-check through file: links to checkouts beside it, and on nothing else at run time", () => {
	assert.deepEqual(pkg.dependencies, { "@agp/node": "file:../agp/packages/node", "@apnex/shape-check": "file:../shape-check" });
	for (const [name, spec] of Object.entries(pkg.devDependencies)) {
		if (name.startsWith("@agp/") || name.startsWith("@apnex/")) assert.match(spec, /^file:\.\.\//, `${name} is linked from a checkout beside this one`);
	}
	assert.equal(pkg.devDependencies["@apnex/entity-store"], "file:../entity-store", "entity-store, for E9's comparison");
});
