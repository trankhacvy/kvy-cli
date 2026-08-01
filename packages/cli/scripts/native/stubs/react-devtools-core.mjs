// Stub for the native build's bundling step only (see build.mjs's `alias`).
//
// `ink` dynamically `import()`s its own `devtools.js`, which does a static
// `import devtools from 'react-devtools-core'` — real, but only ever reached
// when `process.env.DEV === 'true'` AND the package is actually installed
// (see ink/build/reconciler.js). Under plain Node that's fully lazy and
// harmless when the package is absent. esbuild's bundler isn't lazy about
// it: resolving a dynamic import() target still means resolving *that
// module's* own static imports up front, at bundle time, whether or not the
// guard would ever let it run. Aliasing to this empty stub lets bundling
// succeed without installing the real (large, dev-only) package — the code
// path that would use it never executes in a shipped binary anyway.
export default {};
