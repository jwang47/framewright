"""Generate the public recipe schema and validate recipes offline with stdlib.

The shape follows clean_edit; numeric ranges and collection limits come directly
from server. Validation is deliberately strict: cleaning may clamp known values
and omit defaults, while checking catches typos and values outside the contract.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import re

from .server import (EDIT_RANGES, LOOK_FIELDS, MASK_GEOMETRY, MASK_RANGES, MAX_MASKS,
                    MAX_MASK_NAME, MAX_STROKES, MAX_STROKE_POINTS, MAX_MASK_BITMAP,
                    PNG_DATA_URL, CURVE_CHANNELS, MAX_CURVE_POINTS, clean_edit)


def number(lo=None, hi=None, **extra):
    return {"type": "number", **({"minimum": lo} if lo is not None else {}),
            **({"maximum": hi} if hi is not None else {}), **extra}


def obj(properties, required=()):
    return {"type": "object", "properties": properties, "additionalProperties": False,
            **({"required": list(required)} if required else {})}


def array(items, minimum=0, maximum=None):
    return {"type": "array", "items": items, "minItems": minimum,
            **({"maxItems": maximum} if maximum is not None else {})}


def nullable(schema):
    return {"anyOf": [schema, {"type": "null"}]}


def finite_number(value):
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        # JSON can contain arbitrary-size integers that cannot enter the
        # renderer's floating-point representation.
        return False


def recipe_schema():
    point = array(number(0, 100), 2, 2)
    curve = nullable(obj({ch: array(point, 2, MAX_CURVE_POINTS) for ch in CURVE_CHANNELS}))
    properties = {key: number(lo, hi) for key, (lo, hi) in EDIT_RANGES.items()}
    look_properties = {key: properties[key] for key in LOOK_FIELDS if key in properties}
    look_properties.update({
        "curve": curve,
        "lut": {"type": "string", "maxLength": 200, "pattern": r'^[^./\\<>:"|?*\x00-\x1f][^/\\<>:"|?*\x00-\x1f]*\.(cube|xmp)$'},
        "lutHash": {"type": "string", "pattern": r"^[0-9a-f]{16}$"},
    })
    masks = []
    for kind, geometry in MASK_GEOMETRY.items():
        fields = {"type": {"const": kind}, "enabled": {"type": "boolean"},
                  "invert": {"type": "boolean"}, "name": {"type": "string", "maxLength": MAX_MASK_NAME}}
        fields.update({k: number(-1, 2) for k in geometry})
        fields.update({k: number(lo, hi) for k, (lo, hi) in MASK_RANGES.items()
                       if not (k == "feather" and kind in ("linear", "subject"))
                       and not (k == "falloff" and kind != "rect")})
        if kind == "rect":
            fields["angle"] = number(-180, 180)
        if kind == "subject":
            fields.update({
                "strokes": array(obj({"pts": array(array(number(-1, 2), 2, 2), 1, MAX_STROKE_POINTS),
                                      "r": number(0.0005, 0.5), "sub": {"type": "boolean"}},
                                     ("pts", "r")), 0, MAX_STROKES),
                "bitmap": nullable({"type": "string", "pattern": "^" + re.escape(PNG_DATA_URL),
                                    "maxLength": MAX_MASK_BITMAP}),
                "map": array(number(-2, 2), 6, 6),
            })
        masks.append(obj(fields, ("type", *geometry)))
    properties.update({
        "version": {"type": "integer", "const": 1},
        "orient": {"type": "integer", "enum": [0, 90, 180, 270]},
        "flipH": {"type": "boolean"}, "flipV": {"type": "boolean"},
        "source": {"enum": ["raw", "jpeg"]},
        "masks": array({"oneOf": masks}, 0, MAX_MASKS),
        "curve": curve,
        "crop": nullable(obj({"x": number(0, 1), "y": number(0, 1),
                              "w": number(0, 1, exclusiveMinimum=0),
                              "h": number(0, 1, exclusiveMinimum=0)}, ("x", "y", "w", "h"))),
        "groundArea": nullable(array(array(number(-1, 2), 2, 2), 3, 8)),
        "lens": nullable(obj({"model": {"type": "string", "maxLength": 120},
                              "focal": number(), "k": array(number(exclusiveMinimum=-10, exclusiveMaximum=10), 5, 5),
                              "scale": number(exclusiveMinimum=0.2, exclusiveMaximum=5)}, ("k",))),
        "look": nullable(obj({"name": {"type": "string", "maxLength": 80},
                              "params": {**obj(look_properties), "dependentRequired": {"lutHash": ["lut"]}}}, ("params",))),
        "lookAmount": number(0, 100),
    })
    return {"$schema": "https://json-schema.org/draft/2020-12/schema",
            "title": "Framewright recipe", "description": "Generated from the clean_edit contract. Run render --check for semantic checks such as unique curve x coordinates.",
            **obj(properties)}


def _validate(value, schema, path="recipe"):
    # Only the keywords produced above are needed. No remote schema fetching.
    for keyword in ("anyOf", "oneOf"):
        if keyword in schema:
            successes = 0
            failures = []
            for branch in schema[keyword]:
                try:
                    _validate(value, branch, path)
                    successes += 1
                except ValueError as exc:
                    failures.append(str(exc))
            if successes == 0 or (keyword == "oneOf" and successes != 1):
                raise ValueError(f"{path}: does not match an allowed shape ({'; '.join(failures)})")
    kind = schema.get("type")
    valid = {
        "object": isinstance(value, dict), "array": isinstance(value, list),
        "number": finite_number(value),
        "integer": finite_number(value) and value == int(value),
        "string": isinstance(value, str), "boolean": isinstance(value, bool), "null": value is None,
    }
    if kind and not valid[kind]:
        raise ValueError(f"{path}: expected {kind}")
    if "const" in schema and (value != schema["const"] or isinstance(value, bool)):
        raise ValueError(f"{path}: expected {schema['const']!r}")
    if "enum" in schema and value not in schema["enum"]:
        raise ValueError(f"{path}: expected one of {schema['enum']}")
    if kind == "object":
        unknown = set(value) - set(schema["properties"])
        if unknown:
            raise ValueError(f"{path}: unknown fields {', '.join(sorted(unknown))}")
        missing = set(schema.get("required", [])) - set(value)
        if missing:
            raise ValueError(f"{path}: missing fields {', '.join(sorted(missing))}")
        for key, item in value.items():
            _validate(item, schema["properties"][key], f"{path}.{key}")
    if kind == "array":
        if len(value) < schema.get("minItems", 0) or len(value) > schema.get("maxItems", float("inf")):
            raise ValueError(f"{path}: invalid number of items")
        for index, item in enumerate(value):
            _validate(item, schema["items"], f"{path}[{index}]")
    if kind == "number":
        if (value < schema.get("minimum", -float("inf")) or value > schema.get("maximum", float("inf"))
                or value <= schema.get("exclusiveMinimum", -float("inf"))
                or value >= schema.get("exclusiveMaximum", float("inf"))):
            raise ValueError(f"{path}: number is outside the allowed range")
    if kind == "string":
        if len(value) > schema.get("maxLength", float("inf")) or ("pattern" in schema and not re.search(schema["pattern"], value)):
            raise ValueError(f"{path}: invalid string")


def validate_recipe(value):
    _validate(value, recipe_schema())
    look = (value.get("look") or {}).get("params", {})
    if look.get("lutHash") and not look.get("lut"):
        raise ValueError("recipe.look.params.lutHash requires lut")
    cleaned = clean_edit(value)
    # Reject an invalid value introduced by normalization as well. This also
    # guarantees proposals serialize as standards-compliant JSON.
    json.dumps(cleaned, allow_nan=False)
    return cleaned


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, help="write generated JSON Schema (stdout by default)")
    args = parser.parse_args(argv)
    text = json.dumps(recipe_schema(), indent=2) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text, encoding="utf-8")
    else:
        print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
