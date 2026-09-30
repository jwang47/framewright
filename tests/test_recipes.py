"""Recipe contracts, agent writes, and headless browser discovery."""
import contextlib
import io
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from framewright import server as studio
from framewright import render
from framewright import recipe_schema


class RecipeTests(unittest.TestCase):
    def test_generated_schema_is_current(self):
        path = Path(__file__).resolve().parents[1] / "framewright/recipe.schema.json"
        self.assertEqual(json.loads(path.read_text()), recipe_schema.recipe_schema())

    def test_clamping_defaults_and_finite_numbers(self):
        self.assertEqual(studio.clean_edit({"exposure": 9, "grain": 4}),
                         {"version": 1, "exposure": 4, "grain": 4, "grainSize": 25})
        for value in (True, float("nan"), float("inf"), "2"):
            with self.assertRaises(ValueError):
                studio.clean_edit({"exposure": value})
        with self.assertRaises(ValueError):
            studio.clean_edit({"lens": {"k": [0] * 5, "focal": math.inf}})

    def test_strict_validation_rejects_unknown_nested_fields_and_ranges(self):
        invalid = [
            {"exposur": 1}, {"exposure": 5}, {"exposure": True}, {"version": 2},
            {"crop": {"x": 0, "y": 0, "w": 0, "h": 1}},
            {"look": {"params": {"exposure": 1}}},
            {"look": {"params": {"lutHash": "a" * 16}}},
            {"curve": {"rgb": [[0, 1], [0, 100]]}},
            {"masks": [{"type": "subject", "strokes": [{"pts": [[0, 0]], "r": 1}]}]},
            {"masks": [{"type": "radial", "cx": 0.5, "cy": 0.5, "rx": 0.1, "ry": 0.1, "typo": 1}]},
        ]
        for params in invalid:
            with self.subTest(params=params), self.assertRaises(ValueError):
                recipe_schema.validate_recipe(params)

    def test_nested_recipe_roundtrip(self):
        params = {
            "source": "raw", "crop": {"x": 0.1, "y": 0.2, "w": 0.8, "h": 0.7},
            "curve": {"rgb": [[0, 0], [50, 60], [100, 100]]},
            "groundArea": [[0, 0], [1, 0], [1, 1]],
            "lens": {"k": [0] * 5, "scale": 1, "focal": 35},
            "look": {"name": "Warm", "params": {"temp": 10}},
            "masks": [{"type": "subject", "strokes": [{"pts": [[0.5, 0.5]], "r": 0.1}]}],
        }
        cleaned = recipe_schema.validate_recipe(params)
        self.assertEqual(recipe_schema.validate_recipe(cleaned), cleaned)

    def test_check_is_offline_and_does_not_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / "recipe.json"
            file.write_text('{"exposure": 1}')
            with patch.object(render, "find_chrome", side_effect=AssertionError("browser used")), \
                    patch.object(render, "resolve_library", side_effect=AssertionError("library used")), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(render.main(["--check", str(file)]), 0)
            self.assertEqual(list(Path(tmp).iterdir()), [file])

    def test_check_reports_nonfinite_and_huge_values_without_traceback(self):
        for text in ('{"exposure": NaN}', '{"exposure": Infinity}',
                     '{"exposure": 1e1000}', '{"exposure": ' + '9' * 500 + '}'):
            with self.subTest(text=text[:40]), patch.object(sys, "stdin", io.StringIO(text)), \
                    contextlib.redirect_stderr(io.StringIO()) as stderr:
                self.assertEqual(render.main(["--check", "-"]), 1)
                self.assertIn("expected number", stderr.getvalue())
                self.assertNotIn("Traceback", stderr.getvalue())
        self.assertEqual(recipe_schema.validate_recipe({"version": 1.0}), {"version": 1})

    def test_proposal_preserves_edit_and_requires_explicit_replacement(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            raw = root / "shoot/raw"
            raw.mkdir(parents=True)
            (raw / "frame.JPG").write_bytes(b"test frame")
            edit = raw / "frame.edit.json"
            edit.write_text('{"exposure": 2}')
            recipe = root / "recipe.json"
            recipe.write_text('{"exposure": 0.5, "contrast": 0}')
            proposed = render.write_proposal(root, "shoot/frame", str(recipe), "Warmer test")
            self.assertEqual(json.loads(proposed.read_text())["params"], {"version": 1, "exposure": 0.5})
            self.assertEqual(edit.read_text(), '{"exposure": 2}')
            with self.assertRaises(ValueError):
                render.write_proposal(root, "shoot/frame", str(recipe))
            render.write_proposal(root, "shoot/frame", str(recipe), replace=True)
            with self.assertRaises(ValueError):
                render.write_proposal(root / "shoot", "../shoot/frame", str(recipe))

    def test_browser_discovery_reports_help_and_supports_windows_edge(self):
        with patch.object(render.Path, "is_file", return_value=False), \
                patch.object(render.shutil, "which", return_value=None), patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(ValueError, "Edge or Brave"):
                render.find_chrome()
        with tempfile.TemporaryDirectory() as tmp:
            edge = Path(tmp) / "Microsoft/Edge/Application/msedge.exe"
            edge.parent.mkdir(parents=True)
            edge.touch()
            with patch.object(render.shutil, "which", return_value=None), \
                    patch.object(render, "CHROMES", ()), patch.dict(os.environ, {"PROGRAMFILES": tmp}, clear=True):
                self.assertEqual(render.find_chrome(), str(edge))


if __name__ == "__main__":
    unittest.main()
