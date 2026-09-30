# Contributing to Framewright

Use Python 3.10 or newer. The application uses the standard library and native
browser modules; no JavaScript build step or runtime package install is needed.
Run `python -m framewright --library /absolute/path/to/a/test-library` from a
checkout. Keep photos, recipes and LUTs in that separate library.

Before submitting a change, run:

```sh
python -m unittest discover -s tests -v
node --test tests/*.test.mjs
python tools/check_release.py --all
```

Node 22 is only needed for JavaScript tests. Test import, deletion and offload
with disposable synthetic files, never your only copy of a photograph. Explain
the user-visible problem, the change and how you verified it in pull requests.

When changing recipe fields, update the cleaner, renderer and schema generator
together, then regenerate `framewright/recipe.schema.json`. Add focused tests
for behavior, especially data preservation, conflicts and cross-platform paths.

Contributions are licensed under the repository's MIT license. Preserve the
separate notices for vendored components. Never add third-party LUTs or film
profiles, or derive distributable looks from them. Prefer generated test inputs.
Sample photographs must have redistribution permission, consent from anyone
depicted, and no EXIF GPS data; place approved samples only in `docs/samples/`.

To contribute a camera profile, follow [the profile guide](docs/camera-profiles.md).
Submit only the fitted numbers, camera make/model and methodology. Do not attach
private calibration frames. See [AGENTS.md](AGENTS.md) for agent editing rules.
