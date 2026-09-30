# LibRaw for the browser

`index.js`, `worker.js`, `libraw.js` and `libraw.wasm` are the `dist/` files of
[libraw-wasm](https://github.com/ybouane/LibRaw-Wasm) 1.6.0 (ISC licence),
a WebAssembly build of [LibRaw](https://www.libraw.org/) (LGPL 2.1 or CDDL 1.0).
Source maps were dropped. To update, `npm pack libraw-wasm@<version>` and copy
the same four files.

This build ignores the `gamm` setting and always outputs dcraw's default
gamma curve; `raw.js` undoes it. Check that before relying on `gamm` after an
update.

See the adjacent LICENSE* files and the root THIRD_PARTY.md for all bundled
component notices, exact source links, build versions and binary verification.
The local server sends COOP/COEP headers for the decoder’s shared memory.
