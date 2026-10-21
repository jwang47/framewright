"""Lens names from EXIF match Lensfun's spellings of the same lens."""
import unittest

from framewright import lenses


class LensNameTests(unittest.TestCase):
    def test_exif_names_match_lensfun_spellings(self):
        pairs = [
            ("E 35mm F1.8 OSS", "Sony E 35mm f/1.8 OSS"),
            ("FE 24-70mm F2.8 GM II", "Sony FE 24-70mm f/2.8 GM II"),
            ("E 70-350mm F4.5-6.3 G OSS", "Sony E 70-350mm f/4.5-6.3 G OSS"),
            ("10-18mm F2.8 DC DN | Contemporary 023", "Sigma 10-18mm F2.8 DC DN | Contemporary 023"),
            ("SUMMILUX 1:1.7/28 ASPH.", "Leica SUMMILUX f1.7/28 ASPH."),
            ("XF 18 - 55 mm F2.8-4", "Fujifilm XF 18-55mm f/2.8-4"),
        ]
        for exif, lensfun in pairs:
            with self.subTest(exif=exif):
                self.assertLessEqual(lenses._tokens(exif), lenses._tokens(lensfun))

    def test_different_apertures_do_not_match(self):
        self.assertFalse(lenses._tokens("E 35mm F1.8 OSS") <= lenses._tokens("Sony E 35mm f/2.8 OSS"))


if __name__ == "__main__":
    unittest.main()
