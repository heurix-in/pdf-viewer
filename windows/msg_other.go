//go:build !windows

package main

import (
	"fmt"
	"os"
)

func msgBox(title, text string) { fmt.Fprintln(os.Stderr, title+": "+text) }
func findBrowser() string       { return "" }
func openDefault(url string)    { fmt.Println(url) }

func focusApp() {}
