# Local access and release safety

Framewright and its headless renderer bind to `127.0.0.1`. Keep this loopback-only
binding: the server is a local tool, not a public or multi-user service.
It serves library content to clients on localhost and exposes editing and
file-management actions. Treat local processes and other users of the machine
as able to access it. Do not expose its port through a proxy, tunnel, or LAN
binding, and stop the server when it is not needed.

Requests must use a loopback Host with this server's actual port. Browser Origin
headers must match that origin; cross-site fetches are rejected before dispatch
or body reads. JSON APIs require `application/json`, and LUT/JPEG uploads require
their explicit binary content types. These checks also protect the headless
renderer and reduce cross-site request and DNS-rebinding risks. They are not
authentication against local processes: command-line clients with a loopback
Host may omit Origin and still access the library.

Do not put private photo paths, recipes, images, or licensed LUTs in public bug
reports. Reproduce problems with an empty library or synthetic data where possible.

## Creative-content checks

Run `python tools/check_release.py --all` to inspect tracked working-tree files.
Use `python tools/check_release.py --staged --all` to inspect exact staged contents,
including partial staging. CI runs the working-tree check and the test suite.
Opt into the pre-commit check with `git config core.hooksPath .githooks`.
This replaces any existing hooks-path setting; integrate the command with your
existing hooks instead if needed. The hook requires Python on `PATH`.

The public repository and distribution must contain code and approved demo
assets only. CI and the hook use `--all` so every tracked file is checked.
`tools/export_release.py` prepares an explicit code-only tree without copying
Git history or a library. When developing in an older private mixed-data
repository, omit `--all` to check its public-code allowlist; that limited result
does not authorize publishing the private repository or its history.

The guard rejects `.cube` and `.3dl` files, real `LUT_3D_SIZE` header lines even
when renamed, and PNGs whose names or square cubic dimensions suggest a Hald
CLUT. The Hald check is conservative and can reject ordinary PNGs of those
dimensions; resize legitimate sample images. Image extensions and common binary
signatures are rejected outside `docs/samples/`. Sample images in that directory
still require a manual rights, consent, and EXIF GPS review. Symlinks and
submodules require a separate audit and are rejected in checked paths.

These checks are accidental-content guardrails, not a complete license, privacy,
or malware audit. They do not scan Git history or untracked files, prove ownership,
or detect every encoded/embedded image. A release still requires a clean export, manual review and third-party license
checks. Keep the library and any personal repository history private.
