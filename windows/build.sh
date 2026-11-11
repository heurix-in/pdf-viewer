#!/bin/sh
# Builds ../dist/Heurix-PDF-Viewer.exe (run from anywhere; needs Go and Python with Pillow)
set -e
cd "$(dirname "$0")"
python3 ../src/build.py
python3 gen_syso.py
python3 make_shell.py
cp ../dist/heurix-pdf-viewer.html viewer.html
GOOS=windows GOARCH=amd64 go build -ldflags "-s -w -H=windowsgui" -o ../dist/Heurix-PDF-Viewer.exe .
ls -la ../dist
