# Release candidate manual test

Automated tests use synthetic inputs. Use a separate test library and disposable
copies on a test card/source folder for import, deletion and offload checks.
The following checks exercise real camera/OS behavior that fixtures cannot prove.

- [ ] **Fresh start:** launch `python -m framewright` without saved config. Choose
  an empty folder. The Library tab shows import guidance; restart and confirm
  the selected folder persists. Override it with `--library` and confirm no
  files are written to the app checkout.
- [ ] **Install:** `pipx install PATH_TO_WHEEL`; run `framewright --version` and
  open the app from a working directory outside its checkout.
- [ ] **RAW and JPEG:** open matching frames from each camera you use. Switch
  source, adjust exposure/white balance, zoom, crop and export full size. Check
  orientation, sharpness and colours. Unknown cameras should still decode;
  their JPEG matching is not calibrated until a profile is fitted.
- [ ] **Recipes and live changes:** save an edit, render a trial, run
  `framewright render --check trial.json`, then `framewright render --library
  LIBRARY SHOOT/KEY --propose trial.json --note "Manual test"`. The proposal
  should appear live. Compare, discard, create again and accept. The accepted
  edit must remain unchanged until acceptance.
- [ ] **Looks:** try built-ins, save/delete a custom look, and restart. Add and
  drag in a user-owned `.cube`; confirm it goes to the configured user folder,
  not the checkout. Rename the LUT on disk and reload: a fingerprinted recipe
  should still resolve it. Remove it: the menu/Develop/render output should
  warn. A different file under the old name should produce a mismatch warning.
- [ ] **Import:** test a real card for each desired camera family, including
  RAW+JPEG and XMP/THM/LRV companions. Compare the dry-run plan with the card.
  Import twice; the second run must add nothing. Interrupt a copied batch and
  retry; missing files should complete without duplicated frames.
- [ ] **Folder patterns:** try `{camera}_{date}` with two cameras from the same
  date; check folder names, chronological lists and date-range collections.
- [ ] **Card cleanup:** with disposable source copies only, first import with
  deletion off and confirm every source remains. Import a fresh batch with
  deletion enabled; only copied, verified files should be removed after the
  batch succeeds. Unrecognized files and skipped duplicates remain. Eject.
- [ ] **Offload:** configure a test folder/drive; offload a shoot and verify
  files and manifest. Disconnect the drive; cached thumbnails should remain,
  full-original operations should report unavailability, and Offload should
  disappear. Reconnect and export. Selecting the library itself as the store
  must refuse to remove the original files.
- [ ] **Send:** select File manager and confirm exports are revealed locally.
  If you use Tailscale, select a device and confirm receipt. Without Tailscale,
  File manager remains available.
- [ ] **Post and masks:** create a collection, arrange slides, use a subject
  mask, export and reopen. Confirm accepted edits and layout persist.
- [ ] **Other platforms:** repeat the relevant checks on macOS, Linux and
  Windows, especially removable-drive detection, paths containing spaces,
  browser discovery and preview behavior without ImageMagick.

When reporting a failure, include the OS, browser, camera make/model, command or
UI action, and displayed error. Use synthetic inputs or describe the issue
without attaching private photos, recipes, LUTs or personal paths.
