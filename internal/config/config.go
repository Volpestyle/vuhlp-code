package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

type ModelPolicy struct {
	RequireTools    bool     `json:"require_tools"`
	RequireVision   bool     `json:"require_vision"`
	MaxCostUSD      float64  `json:"max_cost_usd"`
	PreferredModels []string `json:"preferred_models"`
}

type Config struct {
	ListenAddr  string      `json:"listen_addr"`
	DataDir     string      `json:"data_dir"`
	AuthToken   string      `json:"auth_token"`
	ModelPolicy ModelPolicy `json:"model_policy"`
}

func DefaultConfig() Config {
	return Config{
		ListenAddr: "127.0.0.1:8787",
		DataDir:    "~/.agent-harness",
		AuthToken:  "",
		ModelPolicy: ModelPolicy{
			RequireTools:    false,
			RequireVision:   false,
			MaxCostUSD:      5.0,
			PreferredModels: []string{},
		},
	}
}

func ExpandHome(path string) string {
	if path == "" {
		return path
	}
	if strings.HasPrefix(path, "~/") || path == "~" {
		home, err := os.UserHomeDir()
		if err != nil {
			return path
		}
		if path == "~" {
			return home
		}
		return filepath.Join(home, path[2:])
	}
	return path
}

func LoadFromFile(path string) (Config, error) {
	if path == "" {
		return Config{}, errors.New("path is empty")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	var cfg Config
	if err := json.Unmarshal(b, &cfg); err != nil {
		return Config{}, err
	}
	return cfg, nil
}
