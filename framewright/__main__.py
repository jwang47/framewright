"""One entry point for the editor, renderer, importer and schema generator."""
import sys
from . import __version__


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    if args == ["--version"]:
        print(f"Framewright {__version__}")
        return 0
    command = args.pop(0) if args and args[0] in {"serve", "render", "import", "schema"} else "serve"
    if command == "render":
        from .render import main as run
    elif command == "import":
        from .import_photos import main as run
    elif command == "schema":
        from .recipe_schema import main as run
    else:
        from .server import main as run
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
