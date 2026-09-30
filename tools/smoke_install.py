#!/usr/bin/env python3
"""Install a wheel into a disposable venv and exercise it outside the checkout."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import venv


def main():
    wheels = sorted(Path("dist").glob("*.whl"))
    if len(wheels) != 1:
        raise SystemExit("expected exactly one wheel in dist/")
    wheel = wheels[0].resolve()
    with tempfile.TemporaryDirectory(prefix="framewright-install-") as temp:
        root = Path(temp)
        venv.EnvBuilder(with_pip=True).create(root / "venv")
        bin_dir = root / "venv" / ("Scripts" if os.name == "nt" else "bin")
        python = bin_dir / ("python.exe" if os.name == "nt" else "python")
        env = {k: v for k, v in os.environ.items() if k not in {"PYTHONPATH", "PYTHONHOME", "STUDIO_LIBRARY", "STUDIO_STORE", "PHOTO_STORE"}}
        env["STUDIO_CONFIG"] = str(root / "config.json")
        def run(*args):
            subprocess.run([str(python), *args], cwd=root, env=env, check=True)
        run("-m", "pip", "install", "--no-index", "--no-deps", str(wheel))
        run("-m", "framewright", "--version")
        subprocess.run([str(bin_dir / ("framewright.exe" if os.name == "nt" else "framewright")), "--version"], cwd=root, env=env, check=True)
        (root / "recipe.json").write_text('{"exposure": 0.25}')
        run("-m", "framewright", "render", "--check", "recipe.json")
        run("-m", "framewright", "import", "--help")
        run("-c", "from importlib.resources import files; p=files('framewright'); assert (p/'web/index.html').is_file(); assert (p/'web/vendor/libraw/libraw.wasm').is_file(); assert (p/'recipe.schema.json').is_file(); assert (p/'looks.example.json').is_file(); print('Installed resources available outside checkout')")
    print("Installed-wheel smoke check passed")


if __name__ == "__main__":
    main()
