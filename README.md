# Heurix PDF Viewer

Offline PDF viewer, comment tools and PDF editor in a single HTML file (also shipped as a Windows app with tabs).

- `dist/heurix-pdf-viewer.html` - the finished single file (open in any modern browser)
- `dist/Heurix-PDF-Viewer.exe` - Windows app (one window, one tab per PDF)
- `src/` - sources: `head.html` (CSS and markup), `mid.html` (bundled pdf.js and pdf-lib, gzip+base64), `module.js` (viewer), `pdfedit.js` (content-stream editing engine), `edit-ui.js` (Edit mode and text editor), `measure.js` (Distance / Perimeter / Area tools, scale and calibration), `build.py` (joins them and recomputes the CSP hash)
- `windows/` - Go launcher for the .exe (`sh windows/build.sh` builds the viewer, icon resource, tab shell and the exe; embeds `dist/heurix-pdf-viewer.html` as `viewer.html`)
- `tests/` - Node tests of the editing engine (`load.js` loads pdf-lib from `mid.html` output) and Playwright UI tests (`ui_text.py`, `ui_measure*.py`, `ui_regress.py`, sample PDFs in `tests/data/`)

Build: `python3 src/build.py` writes `dist/heurix-pdf-viewer.html`.

## Edit mode
Select objects, erase text (removed from the file itself), move/resize/recolour/delete shapes and pictures, add images, and **edit text**: click a line (or double-click / Enter) and retype it, choosing Sans/Serif/Mono, bold, italic, size and colour. The old words are removed from the file. Replacement text uses a standard font and WinAnsi characters; vertical text is not editable.

## Measurements (Comment tab)
Distance, Perimeter and Area. Click-drag or click points; double-click/Enter finishes, Backspace removes the last point, Esc cancels, Shift locks to 0/45/90 degrees. Calibrate with Ctrl+Shift+C (two points, known length) or pick a scale preset; change scale/units in the Scale panel. Saved as standard Line / PolyLine / Polygon annotations with a Measure dictionary, so they stay editable here.

The top bar has a labelled Save button that highlights when there are unsaved changes.
