package api

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func (s *Server) handleDashboard(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/v1/") {
		http.NotFound(w, r)
		return
	}

	uiDir := findUIRoot()
	if uiDir == "" {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = fmt.Fprint(w, dashboardFallbackHTML)
		return
	}

	path := r.URL.Path
	if strings.HasPrefix(path, "/ui") {
		path = strings.TrimPrefix(path, "/ui")
	}
	if path == "" || path == "/" {
		path = "/index.html"
	}
	path = filepath.ToSlash(path)
	if !fileExists(uiDir, path) {
		path = "/index.html"
	}

	full, ok := safeJoin(uiDir, path)
	if !ok {
		http.NotFound(w, r)
		return
	}
	http.ServeFile(w, r, full)
}

func findUIRoot() string {
	candidates := []string{
		filepath.Join("ui", "build"),
		filepath.Join("ui", "dist"),
	}
	if exe, err := os.Executable(); err == nil && exe != "" {
		exeDir := filepath.Dir(exe)
		candidates = append(candidates,
			filepath.Clean(filepath.Join(exeDir, "..", "ui", "build")),
			filepath.Clean(filepath.Join(exeDir, "..", "ui", "dist")),
		)
	}
	for _, dir := range candidates {
		if info, err := os.Stat(dir); err == nil && info.IsDir() {
			return dir
		}
	}
	return ""
}

func fileExists(root, rel string) bool {
	full, ok := safeJoin(root, rel)
	if !ok {
		return false
	}
	info, err := os.Stat(full)
	if err != nil {
		return false
	}
	return !info.IsDir()
}

func safeJoin(root, rel string) (string, bool) {
	clean := filepath.Clean("/" + strings.TrimPrefix(rel, "/"))
	clean = strings.TrimPrefix(clean, "/")
	full := filepath.Join(root, clean)
	rootClean := filepath.Clean(root)
	if full != rootClean && !strings.HasPrefix(full, rootClean+string(os.PathSeparator)) {
		return "", false
	}
	return full, true
}

const dashboardFallbackHTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Agent Harness</title>
  <style>
    body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; background: #f6f7f9; color: #1c1f24; }
    main { max-width: 720px; margin: 80px auto; background: #fff; border: 1px solid #d6dbe2; border-radius: 10px; padding: 24px; }
    h1 { margin: 0 0 12px 0; font-size: 18px; }
    code { background: #f0f2f5; padding: 2px 6px; border-radius: 6px; }
    pre { background: #0f1115; color: #d1d7e0; padding: 12px; border-radius: 8px; }
  </style>
</head>
<body>
  <main>
    <h1>UI build not found</h1>
    <p>The dashboard UI is served from <code>ui/build</code>.</p>
    <p>Build it with:</p>
    <pre>cd ui
npm install
npm run build</pre>
  </main>
</body>
</html>`
