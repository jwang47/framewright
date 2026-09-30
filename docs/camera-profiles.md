# Camera support and colour profiles

Raw decoding and camera colour matching are separate. LibRaw decodes the
camera formats supported by the bundled build. A colour profile then brings
that decoded raw closer to the camera's own JPEG rendering. A missing colour
profile does not prevent an otherwise supported raw from opening.

`framewright/web/raw.js` decodes with as-shot white balance, linear sRGB
primaries, 16-bit output, no automatic brightness, and highlight blending.
It converts the decoder's output curve back to linear half-float pixels and
restores highlight headroom before handing the image to the renderer.
Develop normally uses a half-size decode; full export can use the original
size. Profiles affect raw images, not the camera JPEG source.

## What an unprofiled camera uses

The lookup key is the exact LibRaw make and model joined by a space, with
whitespace trimmed at the ends. `camera-profiles.json` contains fitted
entries for `Sony ILCE-6700` and `Leica Q2`, and a `default` entry. Unknown
cameras use the default (the fitted a6700 tone curve) with an identity colour matrix. There
is no promise that it will match an unknown camera's JPEG style. If the
profile file cannot be loaded, raw decoding still works without a profile.

## Fit a profile from your own photographs

Use several raw + camera JPEG pairs from the same camera and the same
in-camera picture style. Keep the originals together in a library shoot,
with matching frame keys. Choose varied exposure levels, neutrals and
colours; heavily clipped or crushed frames offer little usable data. The
fitter compares corresponding image positions, so avoid pairs with different
crops or rotations. It accounts for the DNG warp when one is available.

1. Run Framewright against that library and open the app in a browser.
2. Open the browser's developer console and run this, substituting your shoot
   folder and frame keys (without file extensions):

   ```js
   const { fitProfile } = await import('/profile-fit.js');
   const fitted = await fitProfile([
     ['2026-01-01_test-camera', 'FRAME0001'],
     ['2026-01-01_test-camera', 'FRAME0002'],
     ['2026-01-01_test-camera', 'FRAME0003'],
   ], { centre: 0.7 });
   console.log(JSON.stringify({ [fitted.camera]: fitted }, null, 2));
   ```

3. Inspect the result. `camera` must identify the intended camera; `samples`
   should be nonzero; the matrix, all curve values, and `meanError8bit` must
   be finite numbers. The error is the average absolute channel difference
   on the fitting samples in 8-bit sRGB steps, not an independent quality
   score. If the values are invalid, use better-exposed, more varied pairs.
4. Merge the entry under that exact camera key into
   `framewright/web/camera-profiles.json`, preserving other entries and
   `default`. This is a developer workflow: there is currently no profile
   import button or per-user profile override file. Reload the browser after
   changing the JSON; raw/profile caches last for the page's lifetime.
5. Compare raw and camera JPEG sources on additional photographs that were
   not used for fitting. Check skin, neutrals, saturated colours, shadows and
   highlights. Refit if the profile only helps the training images.

The `centre` option selects the central fraction of each image: its default
is `0.9`; a smaller fraction can reduce lens-correction alignment differences
near the edges. The fitter samples a region 96 pixels wide, excludes JPEG
pixels with any channel below 3% or above 96%, and alternates a 3×3 colour
matrix with a monotonic tone curve. Defaults are six fitting iterations and
a chroma weight of six. The curve holds 64 samples over log2 exposure from
−12 to +2. Its output also records pair and sample counts for review.

## Contribute a profile

Submit the JSON numbers and a short description of the camera, JPEG picture
style, lighting range, and held-out comparisons. Fit from photographs you
are entitled to use. A profile contribution does not require uploading your
photos, and must not include third-party film profiles or converted LUTs.
