# operation-call

Give every invocation of a named operation exactly one honest ending, within a bound its caller chose.

**Status: built, and certified at zorg's Delta 1, stage 4 (`2e435a8`), amendment 7 (`2741296`), Delta 2, stage 2 (`e689c73`), and Delta 4, stage 4 (`478809c`).**\
Its contract tests run its caller contract suite against its own caller, and its host's cases, over AGP's production in-process carrier with AGP's injected clock and a separate clock for each call's bound.\
`npm test` also compiles `test/types/caller-interface.ts`, a strict consumer of the caller interface, which passes when it compiles: it accepts operation-call's own caller and a caller across a hop unchanged (zorg's `EM12`).

- `VISION.md` - why it exists, and what it will never be.
- `CONTRACT.md` - what a consumer can depend on, one capability per row.
- `docs/DECISIONS.md` - the rulings about this component.

It belongs to a component set first composed by zorg (`apnex/zorg`), and is private until its first working code.

It depends on `@agp/node` and `@apnex/shape-check` through `file:` links to checkouts beside it, and its tests on `@agp/core`, `@agp/transport-loopback` and `@apnex/entity-store` the same way.\
Each such link installs none of its package's own dependencies, so AGP's packages find theirs through AGP's own workspace install, and each checkout must be installed and built first, since no `dist/` is committed.

To run the tests from clean checkouts:
```sh
(cd ../agp && npm install && npm run build)
(cd ../shape-check && npm install && npm run build)
(cd ../entity-store && npm install && npm run build)
npm install
npm test
```
