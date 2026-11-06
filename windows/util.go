package main

import "os"

func getenv(k string) string { return os.Getenv(k) }
func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}
