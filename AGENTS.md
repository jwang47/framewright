# Working on Framewright and photo recipes

The application and the user's library are separate. Code belongs in this
repository; photos, recipes, picks, exports, LUTs and proposals belong under the
library selected by `--library`, `STUDIO_LIBRARY`, or the user's config. Do not
assume a drive, camera model, shoot name, or default personal library exists.

## Editing a photograph

Never overwrite or delete `*.edit.json` unless the user specifically asks. Those
files are accepted edits. Proposals live beside the corresponding frame under
`<library>/<shoot>/raw/<key>.proposal.json`; the app presents them for review.
Do not replace an existing proposal without first inspecting it and receiving
an instruction to replace it. A request to suggest an edit authorizes creating
a new proposal, not accepting it or altering the saved edit.

1. Read the saved recipe and any existing proposal. Determine whether the frame
   has RAW, JPEG, or both; a recipe's `source` selects its pixels.
2. Render a baseline with `python -m framewright render --library LIBRARY SHOOT/KEY
   --recipe edit -o BASELINE.jpg` and inspect the image.
3. Write a trial recipe to a temporary JSON file outside the code repository.
   Run `python -m framewright render --check TRIAL.json` to catch typos, invalid
   types, out-of-range settings, and invalid nested mask/curve data offline.
4. Render the trial with `python -m framewright render --library LIBRARY SHOOT/KEY
   --recipe TRIAL.json -o TRIAL.jpg`. Inspect it; iterate only when the result
   needs another change. Use `--full` when judging detail or final output.
5. Write a proposal with `python -m framewright render --library LIBRARY SHOOT/KEY
   --propose TRIAL.json --note "What changed and why"`. This validates and cleans
   the recipe through the same `clean_edit` used by the server. It does not
   start a browser or touch the saved edit. `--replace-proposal` is only for an
   explicitly requested replacement. Report the proposal path and visual result.

The render command takes repeated `--recipe` arguments (`edit`, `proposal`,
`none`, a JSON path, or `-` for stdin). A single `-o` JPEG path selects one output;
for multiple renders use an output directory. Without `-o`, review images go to
`<library>/.review/`. Notes about offline sources or missing/mismatched LUTs are
part of the result: disclose them before judging fidelity to an intended look.
Never claim an image was visually checked if only JSON validation was run.

## Recipe contract

`framewright/recipe.schema.json` is the generated JSON Schema. Regenerate it with
`python -m framewright schema --out framewright/recipe.schema.json` when the cleaner
contract changes. `--check` also performs semantic validation that JSON Schema
cannot express, such as repeated x coordinates in a tone curve. `--check` accepts
a recipe or a proposal envelope and needs neither a library nor a browser.

Recipes are objects with `version: 1`. Adjustment ranges come from `EDIT_RANGES`
in `framewright/server.py`; omitted fields have renderer defaults. Geometry includes
`orient`, `flipH`, `flipV`, `crop: {x,y,w,h}`, and perspective controls. `source`
is `raw` or `jpeg`; older saved recipes with no source preserve JPEG behavior
when both files exist. Curves have `rgb`, `r`, `g`, and `b` channels, each a list
of 2–16 `[x,y]` points on the 0–100 scale with unique x coordinates.

A `look` is `{name, params}`, optionally mixed with `lookAmount` (0–100). Its
params only include supported look fields, including an optional external LUT
filename and its `lutHash` (first 16 lowercase SHA256 hex digits). A hash requires
a filename. Masks are a list of up to eight linear, radial, rect or subject
objects; the schema specifies each shape's geometry and adjustment ranges.
Subject bitmaps can contain identifiable people: never copy them into fixtures,
docs, or public reports. `lens` carries numerical coefficients; `groundArea`
holds polygon points. Use synthetic data for tests.

A proposal envelope contains `params` (a cleaned recipe), `note` (up to 500
characters), and `created` (local ISO timestamp). Use `--propose` to produce it.
The cleaner clamps supported numbers and removes neutral/unused settings;
strict `--check`/`--propose` validation rejects values outside the published
contract instead of silently fixing agent mistakes.

## Code and release checks

Keep the application stdlib Python and plain browser JavaScript with no build
step. Run `python -m unittest discover -s tests -v`,
`node --test tests/luts.test.mjs tests/segment.test.mjs`, and
`python tools/check_release.py` for relevant changes. CI runs on Python 3.10/3.12
and Node 22 across macOS, Linux and Windows. Regenerate and test schema changes.
Use fake cards and temporary libraries for import/offload tests. Never test
removal or offloading against someone's real card or library without a request.

Never copy, convert, derive, or embed third-party LUTs/film profiles in this
repository, releases, fixtures, or example looks. Users install their own LUTs
outside the code tree. Sample images require rights/consent review and stripped
GPS metadata; the only image allowlist is `docs/samples/`. See `SECURITY.md` for
release guard boundaries and local-server access. A passing content check does
not authorize publishing this private repository or its history.

The headless renderer discovers Chrome, Chromium, Edge, or Brave; `CHROME`
selects an executable explicitly. ImageMagick or macOS `sips` creates small
preview files when available. Without either, the server serves camera JPEGs
or extracts a RAW's embedded JPEG for browser decoding. These fallback images
retain camera rendering and available embedded orientation, may be larger, and
may be unavailable for a RAW without an embedded JPEG; browser RAW development
still uses LibRaw. Do not substitute a fallback silently when evaluating a RAW
edit's fidelity.
