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

## Remote API (opt-in, tailnet only)

`--remote` (or `"remote": true` in config.json) starts a second, separate
listener for the companion phone app. The studio server above is unchanged:
still loopback-only, with the same Host/Origin checks. The remote listener is
off by default and:

- binds only to this machine's Tailscale address, found with `tailscale ip -4`
  or by scanning interface addresses for 100.64.0.0/10. `--remote-host` (or
  config `remoteHost`) must also be a 100.64.0.0/10 or fd7a:115c:a1e0::/48
  address unless `--remote-allow-any-host` is given, which is meant for local
  testing. It never binds a wildcard address. The default port is 8766
  (`--remote-port`, config `remotePort`). With no Tailscale address it refuses
  to start rather than fall back to another interface.
- requires `Authorization: Bearer TOKEN` on every request. The token is
  checked with a constant-time comparison before routing or reading a body;
  anything else gets 401. The token is generated once with
  `secrets.token_urlsafe(32)` and stored as `remoteToken` in config.json,
  which is written with mode 0600. `python -m framewright remote-token`
  prints it and `--rotate` replaces it; restart and pair devices again.
- serves plain HTTP inside the tailnet. WireGuard encrypts and authenticates
  the traffic between devices, so no TLS is added.
- exposes only `/remote/v1`: shoots and frames, previews, original files of
  listed frames, recipes (revision-checked, through `clean_edit`), proposals
  (accept/discard), picks, looks and the user's LUT files, uploading a photo
  into a new or existing dated shoot (never overwriting), and starting a
  Claude Code suggestion. Shoots and frames are validated against the
  library's own listing; paths are never accepted. JSON bodies are capped at
  16 MB and uploads at 200 MB. There is no file management, import, offload,
  eject, send, export or settings access.
- runs suggestions as `claude -p` in a fresh temporary folder, with tools
  limited to `python3 -m framewright render`, Read, and writing files inside
  that folder. One job runs at a time, five may wait, each is killed after
  10 minutes. Claude's Read tool can read files the user can read; treat a
  suggestion request as running Claude Code as yourself.

Threat model: anyone who can reach the address and holds the token can read
the library's photos, originals and LUTs, change recipes, picks and proposals,
add photos and spend Claude Code usage. Tailnet peers without the token get
only 401s. Use Tailscale ACLs to limit which devices can reach port 8766, keep
the token private (it is printed on start and in the pairing link), and rotate
it if a device is lost. LUTs sent to your phone stay personal-use content.

To turn it off, stop Framewright and start it without `--remote`, and remove
`"remote": true` from config.json. Run `python -m framewright remote-token
--rotate` to invalidate a token that may have leaked.

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
