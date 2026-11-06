//go:build windows

package main

import (
	"os/exec"
	"strings"
	"syscall"
	"unsafe"
)

func msgBox(title, text string) {
	t, _ := syscall.UTF16PtrFromString(title)
	x, _ := syscall.UTF16PtrFromString(text)
	syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(x)), uintptr(unsafe.Pointer(t)), 0x40)
}

func findBrowser() string {
	var roots []string
	for _, k := range []string{"ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"} {
		if v := getenv(k); v != "" {
			roots = append(roots, v)
		}
	}
	rel := []string{`Microsoft\Edge\Application\msedge.exe`, `Google\Chrome\Application\chrome.exe`}
	for _, r := range rel {
		for _, root := range roots {
			p := root + `\` + r
			if fileExists(p) {
				return p
			}
		}
	}
	return ""
}

func openDefault(url string) {
	_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
}

// focusApp brings the running viewer window to the front (restoring it if minimised).
func focusApp() {
	user32 := syscall.NewLazyDLL("user32.dll")
	enumWindows := user32.NewProc("EnumWindows")
	getClassName := user32.NewProc("GetClassNameW")
	getWindowText := user32.NewProc("GetWindowTextW")
	isVisible := user32.NewProc("IsWindowVisible")
	isIconic := user32.NewProc("IsIconic")
	showWindow := user32.NewProc("ShowWindow")
	setForeground := user32.NewProc("SetForegroundWindow")
	keybdEvent := user32.NewProc("keybd_event")

	var found uintptr
	cb := syscall.NewCallback(func(h uintptr, _ uintptr) uintptr {
		if v, _, _ := isVisible.Call(h); v == 0 {
			return 1
		}
		cls := make([]uint16, 64)
		getClassName.Call(h, uintptr(unsafe.Pointer(&cls[0])), 64)
		if syscall.UTF16ToString(cls) != "Chrome_WidgetWin_1" {
			return 1
		}
		txt := make([]uint16, 512)
		getWindowText.Call(h, uintptr(unsafe.Pointer(&txt[0])), 512)
		if strings.Contains(syscall.UTF16ToString(txt), "Heurix PDF Viewer") {
			found = h
			return 0
		}
		return 1
	})
	enumWindows.Call(cb, 0)
	if found == 0 {
		return
	}
	if v, _, _ := isIconic.Call(found); v != 0 {
		showWindow.Call(found, 9) // SW_RESTORE
	}
	keybdEvent.Call(0x12, 0, 0, 0) // a tap of Alt lets us take the foreground
	keybdEvent.Call(0x12, 0, 2, 0)
	setForeground.Call(found)
}
