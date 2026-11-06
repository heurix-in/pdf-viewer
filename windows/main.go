// Heurix PDF Viewer — Windows launcher.
// Serves the single-file viewer from 127.0.0.1 (never reachable from the network),
// opens it in its own app window, and lets "Open with" hand it a PDF.
package main

import (
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

//go:embed viewer.html
var viewerHTML []byte

//go:embed shell.html
var shellHTML []byte

const signature = "heurix-pdf-viewer-2"

var ports = []int{47821, 47822, 47823, 47824, 47825}

func dataDir() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		if d, err := os.UserCacheDir(); err == nil {
			base = d
		} else {
			base = os.TempDir()
		}
	}
	d := filepath.Join(base, "Heurix", "PDF Viewer")
	_ = os.MkdirAll(d, 0o700)
	return d
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// The secret lets a second launch (another "Open with") talk to the running server.
// Web pages cannot read it, so they cannot register files.
func loadSecret() string {
	p := filepath.Join(dataDir(), "secret")
	if f, err := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600); err == nil {
		s := randHex(16)
		_, _ = f.WriteString(s)
		_ = f.Close()
		return s
	}
	for i := 0; i < 20; i++ {
		if b, err := os.ReadFile(p); err == nil && len(strings.TrimSpace(string(b))) == 32 {
			return strings.TrimSpace(string(b))
		}
		time.Sleep(50 * time.Millisecond)
	}
	s := randHex(16)
	_ = os.WriteFile(p, []byte(s), 0o600)
	return s
}

type evt struct {
	Token string `json:"token"`
	Name  string `json:"name"`
	Key   string `json:"key"`
}

type server struct {
	mu          sync.Mutex
	port        int
	secret      string
	tokens      map[string]string
	subs        map[int]chan evt
	nextSub     int
	backlog     []evt
	launchUntil time.Time
	emptySince  time.Time
	done        chan struct{}
}

// enqueue hands a file (or just "show the window", when path is empty) to the viewer.
// open is true when no viewer window is running, so the caller must start one.
func (s *server) enqueue(path string) (token string, open bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	live := len(s.subs) > 0 || time.Now().Before(s.launchUntil)
	if path != "" {
		token = randHex(16)
		s.tokens[token] = path
		e := evt{Token: token, Name: filepath.Base(path), Key: strings.ToLower(path)}
		newest := -1
		for id := range s.subs {
			if id > newest {
				newest = id
			}
		}
		if newest >= 0 {
			select {
			case s.subs[newest] <- e:
			default:
			}
		} else {
			s.backlog = append(s.backlog, e)
		}
	}
	if !live {
		s.launchUntil = time.Now().Add(25 * time.Second)
		open = true
	}
	return token, open
}

func (s *server) addSub() (int, chan evt) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextSub++
	ch := make(chan evt, 64)
	s.subs[s.nextSub] = ch
	for _, e := range s.backlog {
		ch <- e
	}
	s.backlog = nil
	return s.nextSub, ch
}

func (s *server) delSub(id int) {
	s.mu.Lock()
	delete(s.subs, id)
	s.mu.Unlock()
}

func (s *server) path(r *http.Request) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.tokens[r.URL.Query().Get("t")]
	return p, ok
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Host != fmt.Sprintf("127.0.0.1:%d", s.port) { // blocks DNS-rebinding tricks
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	h := w.Header()
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	if r.URL.Path != "/" {
		if v := r.Header.Get("Sec-Fetch-Site"); v != "" && v != "same-origin" {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
	}
	switch r.URL.Path {
	case "/", "/viewer":
		if r.Method != http.MethodGet {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		h.Set("Content-Type", "text/html; charset=utf-8")
		if r.URL.Path == "/" {
			_, _ = w.Write(shellHTML)
		} else {
			_, _ = w.Write(viewerHTML)
		}
	case "/favicon.ico":
		w.WriteHeader(http.StatusNoContent)
	case "/__ping":
		_, _ = io.WriteString(w, signature)
	case "/__meta":
		p, ok := s.path(r)
		if !ok {
			http.NotFound(w, r)
			return
		}
		st, err := os.Stat(p)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		h.Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"name": filepath.Base(p), "size": st.Size()})
	case "/__file":
		p, ok := s.path(r)
		if !ok {
			http.NotFound(w, r)
			return
		}
		switch r.Method {
		case http.MethodGet:
			f, err := os.Open(p)
			if err != nil {
				http.NotFound(w, r)
				return
			}
			defer f.Close()
			h.Set("Content-Type", "application/pdf")
			_, _ = io.Copy(w, f)
		case http.MethodPut:
			if r.Header.Get("X-Heurix") != "1" {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			s.save(w, r, p)
		default:
			http.Error(w, "method", http.StatusMethodNotAllowed)
		}
	case "/__events":
		fl, ok := w.(http.Flusher)
		if !ok || r.Method != http.MethodGet {
			http.Error(w, "unsupported", http.StatusBadRequest)
			return
		}
		h.Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fl.Flush()
		id, ch := s.addSub()
		defer s.delSub(id)
		tick := time.NewTicker(10 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case e := <-ch:
				b, _ := json.Marshal(e)
				if _, err := fmt.Fprintf(w, "data: %s\n\n", b); err != nil {
					return
				}
				fl.Flush()
			case <-tick.C:
				if _, err := io.WriteString(w, ": keep-alive\n\n"); err != nil {
					return
				}
				fl.Flush()
			}
		}
	case "/__reg":
		if r.Method != http.MethodPost || r.Header.Get("X-Heurix-Secret") != s.secret {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		b, _ := io.ReadAll(io.LimitReader(r.Body, 32768))
		p := string(b)
		if p != "" && !isPDFPath(p) {
			http.Error(w, "not a pdf", http.StatusBadRequest)
			return
		}
		tok, open := s.enqueue(p)
		h.Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"token": tok, "open": open})
	default:
		http.NotFound(w, r)
	}
}

// save writes next to the original, then swaps it in, so a failure never leaves a half-written PDF.
func (s *server) save(w http.ResponseWriter, r *http.Request, p string) {
	r.Body = http.MaxBytesReader(w, r.Body, 2<<30)
	tmp := filepath.Join(filepath.Dir(p), "."+filepath.Base(p)+".heurix-tmp")
	f, err := os.Create(tmp)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	head := make([]byte, 5)
	n, _ := io.ReadFull(r.Body, head)
	if n < 5 || string(head) != "%PDF-" {
		f.Close()
		os.Remove(tmp)
		http.Error(w, "not a pdf", http.StatusBadRequest)
		return
	}
	_, err = f.Write(head)
	if err == nil {
		_, err = io.Copy(f, r.Body)
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp, p)
	}
	if err != nil {
		os.Remove(tmp)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func isPDFPath(p string) bool {
	if !strings.EqualFold(filepath.Ext(p), ".pdf") || !filepath.IsAbs(p) {
		return false
	}
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

// The server quits on its own once the viewer window has been closed.
func (s *server) watch() {
	for range time.Tick(2 * time.Second) {
		s.mu.Lock()
		now := time.Now()
		quit := false
		if len(s.subs) == 0 && now.After(s.launchUntil) {
			if s.emptySince.IsZero() {
				s.emptySince = now
			} else if now.Sub(s.emptySince) > 4*time.Second {
				quit = true
			}
		} else {
			s.emptySince = time.Time{}
		}
		s.mu.Unlock()
		if quit {
			close(s.done)
			return
		}
	}
}

func ping(port int) bool {
	c := http.Client{Timeout: 700 * time.Millisecond}
	resp, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/__ping", port))
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 64))
	return string(b) == signature
}

func registerRemote(port int, secret, path string) (open bool, err error) {
	req, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/__reg", port), strings.NewReader(path))
	req.Header.Set("X-Heurix-Secret", secret)
	c := http.Client{Timeout: 3 * time.Second}
	resp, err := c.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	if resp.StatusCode != 200 {
		return false, fmt.Errorf("%s", strings.TrimSpace(string(b)))
	}
	var out struct {
		Open bool `json:"open"`
	}
	if err := json.Unmarshal(b, &out); err != nil {
		return false, err
	}
	return out.Open, nil
}

func openWindow(port int) {
	url := fmt.Sprintf("http://127.0.0.1:%d/", port)
	if os.Getenv("HEURIX_NOBROWSER") != "" {
		fmt.Println(url)
		return
	}
	if b := findBrowser(); b != "" {
		profile := filepath.Join(dataDir(), "profile")
		if err := exec.Command(b, "--app="+url, "--user-data-dir="+profile, "--no-first-run", "--no-default-browser-check").Start(); err == nil {
			return
		}
	}
	openDefault(url)
}

func main() {
	var files []string
	for _, a := range os.Args[1:] {
		if strings.HasPrefix(a, "-") {
			continue
		}
		p, err := filepath.Abs(a)
		if err != nil || !isPDFPath(p) {
			msgBox("Heurix PDF Viewer", "This file can't be opened because it isn't a PDF:\n\n"+a)
			continue
		}
		files = append(files, p)
	}
	if len(os.Args) > 1 && len(files) == 0 && os.Getenv("HEURIX_NOBROWSER") == "" {
		return
	}
	secret := loadSecret()
	targets := files
	if len(targets) == 0 {
		targets = []string{""} // just show the window
	}
	for attempt := 0; attempt < 3; attempt++ {
		s := &server{secret: secret, tokens: map[string]string{}, subs: map[int]chan evt{}, done: make(chan struct{})}
		port := 0
		for _, p := range ports {
			ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
			if err == nil {
				s.port = p
				port = p
				go func() { _ = http.Serve(ln, s) }()
				break
			}
			if ping(p) { // the viewer is already running: hand it the files
				port = p
				break
			}
		}
		if port == 0 {
			msgBox("Heurix PDF Viewer", "Could not start. Ports 47821–47825 are in use by other programs.")
			return
		}
		if s.port != 0 { // we are the viewer's server
			launched := false
			for _, f := range targets {
				if _, open := s.enqueue(f); open && !launched {
					launched = true
					openWindow(port)
				}
			}
			go s.watch()
			<-s.done
			return
		}
		failed := false
		raise := true
		for _, f := range targets {
			open, err := registerRemote(port, secret, f)
			if err != nil {
				failed = true // the old viewer was just shutting down: try again as the new server
				break
			}
			if open {
				raise = false
				openWindow(port)
			}
		}
		if failed {
			time.Sleep(400 * time.Millisecond)
			continue
		}
		if raise {
			focusApp()
		}
		return
	}
}
