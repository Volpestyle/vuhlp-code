package main

import (
	"context"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	aikit "github.com/Volpestyle/ai-kit/packages/go"
	"github.com/yourorg/coding-agent-harness/internal/agent"
	"github.com/yourorg/coding-agent-harness/internal/api"
	"github.com/yourorg/coding-agent-harness/internal/config"
	"github.com/yourorg/coding-agent-harness/internal/runstore"
	"github.com/yourorg/coding-agent-harness/internal/util"
)

func main() {
	var (
		flagListen  = flag.String("listen", "", "listen address (default 127.0.0.1:8787)")
		flagDataDir = flag.String("data-dir", "", "data directory (default ~/.agent-harness)")
		flagAuth    = flag.String("auth-token", "", "auth token (Bearer). If set, required for all requests.")
		flagConfig  = flag.String("config", "", "optional config JSON file (see .harness/config.example.json)")
	)
	flag.Parse()

	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	cfg := config.DefaultConfig()

	// Config file (optional)
	if *flagConfig == "" {
		*flagConfig = os.Getenv("HARNESS_CONFIG")
	}
	if *flagConfig != "" {
		if loaded, err := config.LoadFromFile(*flagConfig); err == nil {
			cfg = loaded
		} else {
			logger.Warn("failed to load config file", "path", *flagConfig, "err", err)
		}
	}

	// Env overrides (only if config fields are empty).
	if v := os.Getenv("HARNESS_LISTEN"); v != "" && cfg.ListenAddr == "" {
		cfg.ListenAddr = v
	}
	if v := os.Getenv("HARNESS_DATA_DIR"); v != "" && cfg.DataDir == "" {
		cfg.DataDir = v
	}
	if v := os.Getenv("HARNESS_AUTH_TOKEN"); v != "" && cfg.AuthToken == "" {
		cfg.AuthToken = v
	}

	// Flag overrides.
	if *flagListen != "" {
		cfg.ListenAddr = *flagListen
	}
	if *flagDataDir != "" {
		cfg.DataDir = *flagDataDir
	}
	if *flagAuth != "" {
		cfg.AuthToken = *flagAuth
	}

	cfg.DataDir = util.ExpandHome(cfg.DataDir)

	store := runstore.New(cfg.DataDir)
	if err := store.Init(); err != nil {
		logger.Error("store init failed", "err", err)
		os.Exit(1)
	}

	kitConfig := aikit.Config{
		RegistryTTL: 15 * time.Minute,
	}
	openAIKey := strings.TrimSpace(os.Getenv("OPENAI_API_KEY"))
	openAIKeys := parseKeyList(os.Getenv("OPENAI_API_KEYS"))
	if openAIKey != "" || len(openAIKeys) > 0 {
		kitConfig.OpenAI = &aikit.OpenAIConfig{
			APIKey:  openAIKey,
			APIKeys: openAIKeys,
		}
	}
	anthropicKey := strings.TrimSpace(os.Getenv("ANTHROPIC_API_KEY"))
	anthropicKeys := parseKeyList(os.Getenv("ANTHROPIC_API_KEYS"))
	if anthropicKey != "" || len(anthropicKeys) > 0 {
		kitConfig.Anthropic = &aikit.AnthropicConfig{
			APIKey:  anthropicKey,
			APIKeys: anthropicKeys,
		}
	}
	xaiKey := strings.TrimSpace(os.Getenv("XAI_API_KEY"))
	xaiKeys := parseKeyList(os.Getenv("XAI_API_KEYS"))
	if xaiKey != "" || len(xaiKeys) > 0 {
		kitConfig.XAI = &aikit.XAIConfig{
			APIKey:  xaiKey,
			APIKeys: xaiKeys,
		}
	}
	googleKey := strings.TrimSpace(os.Getenv("GOOGLE_API_KEY"))
	googleKeys := parseKeyList(os.Getenv("GOOGLE_API_KEYS"))
	if googleKey != "" || len(googleKeys) > 0 {
		kitConfig.Google = &aikit.GoogleConfig{
			APIKey:  googleKey,
			APIKeys: googleKeys,
		}
	}
	ollamaBase := strings.TrimSpace(os.Getenv("OLLAMA_BASE_URL"))
	ollamaKey := strings.TrimSpace(os.Getenv("OLLAMA_API_KEY"))
	ollamaKeys := parseKeyList(os.Getenv("OLLAMA_API_KEYS"))
	if ollamaBase != "" || ollamaKey != "" || len(ollamaKeys) > 0 {
		kitConfig.Ollama = &aikit.OllamaConfig{
			BaseURL: ollamaBase,
			APIKey:  ollamaKey,
			APIKeys: ollamaKeys,
		}
	}
	if !hasProviderConfig(kitConfig) {
		if ollamaBase == "" {
			ollamaBase = "http://localhost:11434"
		}
		kitConfig.Ollama = &aikit.OllamaConfig{BaseURL: ollamaBase}
		logger.Info("ai-kit: no provider keys configured; defaulting to Ollama", "base_url", ollamaBase)
	}

	kit, err := aikit.New(kitConfig)
	if err != nil {
		logger.Error("ai-kit init failed", "err", err)
		os.Exit(1)
	}

	runner := agent.NewRunner(logger, store, kit, &aikit.ModelRouter{}, cfg.ModelPolicy)

	srv := &api.Server{
		Logger:    logger,
		Store:     store,
		Runner:    runner,
		AuthToken: cfg.AuthToken,
	}

	httpSrv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		logger.Info("agentd listening", "addr", cfg.ListenAddr, "data_dir", cfg.DataDir)
		if cfg.AuthToken != "" {
			logger.Info("auth enabled", "mode", "bearer")
		}
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("http server failed", "err", err)
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 2)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	logger.Info("shutting down")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(ctx)
}

func parseKeyList(value string) []string {
	var out []string
	for _, part := range strings.FieldsFunc(value, func(r rune) bool {
		return r == ',' || r == ';' || r == ' ' || r == '\n' || r == '\t'
	}) {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func hasProviderConfig(cfg aikit.Config) bool {
	return cfg.OpenAI != nil ||
		cfg.Anthropic != nil ||
		cfg.XAI != nil ||
		cfg.Google != nil ||
		cfg.Ollama != nil
}
