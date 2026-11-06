# Heurix PDF Viewer

Offline PDF viewer, comment tools and PDF editor in a single HTML file (also shipped as a Windows app with tabs).

- `dist/heurix-pdf-viewer.html` - the finished single file (open in any modern browser)
- `dist/Heurix-PDF-Viewer.exe` - Windows app (one window, one tab per PDF)
- `src/` - sources: `head.html` (CSS and markup), `mid.html` (bundled pdf.js and pdf-lib, gzip+base64), `module.js` (viewer), `pdfedit.js` (content-stream editing engine), `edit-ui.js` (Edit mode), `build.py` (joins them and recomputes the CSP hash)
- `windows/` - Go launcher for the .exe (`GOOS=windows GOARCH=amd64 go build -ldflags "-s -w -H=windowsgui"`; embeds `dist/heurix-pdf-viewer.html` as `viewer.html`)
- `tests/` - Node tests of the editing engine (`load.js` loads pdf-lib from `mid.html` output) and Playwright UI tests

Build: `python3 src/build.py` writes `dist/heurix-pdf-viewer.html`.

## Edit mode
Select objects, erase text (removed from the file itself), move/resize/recolour/delete shapes and pictures, add images. Not yet: moving or retyping existing text.
