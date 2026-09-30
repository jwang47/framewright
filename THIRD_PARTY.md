# Third-party software

Framewright's own code is MIT licensed. Vendored software keeps the licenses
listed here; the root license does not replace them.

## Browser RAW decoder

`framewright/web/vendor/libraw/` contains LibRaw-Wasm **1.6.0** from
[the npm release](https://registry.npmjs.org/libraw-wasm/1.6.0), built from
[commit 32fd36a9883a10c1632bc20073f1ea88cc60487a](https://github.com/ybouane/LibRaw-Wasm/tree/32fd36a9883a10c1632bc20073f1ea88cc60487a).
Its wrapper declares ISC. We removed only the source-map URL comments from
`index.js` and `worker.js`; the `.wasm` matches the published binary byte for
byte. The npm tarball SHA1 is `2e97e53979c8abbbb2230b7755f84bc296e28838`.

The pinned upstream build recipe and Emscripten port definitions identify:

| Component | Version | License / source |
| --- | --- | --- |
| LibRaw | 0.22.1 | CDDL 1.0 or LGPL 2.1, [source](https://github.com/LibRaw/LibRaw/tree/0.22.1) |
| Little CMS | 2.19.1 | MIT, [source](https://github.com/mm2/Little-CMS/tree/lcms2.19.1) |
| Emscripten runtime | 5.0.7 | MIT / NCSA and runtime notices, [source](https://github.com/emscripten-core/emscripten/tree/5.0.7) |
| libjpeg | 9f | IJG, [source archive](https://storage.googleapis.com/webassembly/emscripten-ports/jpegsrc.v9f.tar.gz) |
| libpng | 1.6.55 | PNG reference library license, [source](https://github.com/pnggroup/libpng/tree/v1.6.55) |
| zlib | 1.3.1 | zlib, [source](https://github.com/madler/zlib/tree/v1.3.1) |

This software is based in part on the work of the Independent JPEG Group.
LibRaw also credits dcraw, DCB/FBDD, X3F and Adobe DNG code. Its copyright
notice and component license blocks are preserved alongside the main licenses.
The adjacent `license-sources.json` records where each notice was obtained
and its SHA256. All notices are included in the installed package.

Framewright distributes the LibRaw component under its CDDL option. Its
corresponding source is available under that license from the versioned source
link above; wrapper/build source is at the pinned LibRaw-Wasm commit. Both
upstream LibRaw license alternatives are included for reference.

To rebuild or replace the decoder, follow the pinned upstream
[`compileLibraw.sh`](https://github.com/ybouane/LibRaw-Wasm/blob/32fd36a9883a10c1632bc20073f1ea88cc60487a/compileLibraw.sh)
with Emscripten 5.0.7, Node and the documented native build tools. Copy the
resulting `dist/index.js`, `dist/worker.js`, `dist/libraw.js` and
`dist/libraw.wasm` over the corresponding files in
`framewright/web/vendor/libraw/`, then restart/reload Framewright. There are no
signature checks or embedding steps that prevent a user-supplied build.
Decoder replacement does not require rebuilding the editor.

The shipped main binary's SHA256 is
`8947f7e668e488461c3e9defe7007583aa8477b4886aa603b36b407f2f0846ff`.
The gamma setting in this build behaves like dcraw's default; `raw.js`
compensates for it. Test this behavior when updating the decoder.

## Optional local programs and databases

Lensfun's database is read from the user's installation and is **not bundled**.
The database uses CC BY-SA 3.0; see [Lensfun](https://lensfun.github.io/).
ImageMagick, macOS `sips`, Chrome/Chromium, Edge/Brave, Tailscale and native file
managers are optional system programs. Their licenses apply to their own
installations; they are not redistributed by Framewright.

No third-party LUT, film profile, photographic sample or converted derivative
ships with Framewright. Built-in example looks are original numeric settings.
