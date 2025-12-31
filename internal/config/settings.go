package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

type Settings struct {
	ModelPolicy ModelPolicy `json:"model_policy"`
}

func LoadSettings(path string) (Settings, bool, error) {
	if path == "" {
		return Settings{}, false, errors.New("path is empty")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Settings{}, false, nil
		}
		return Settings{}, false, err
	}
	var cfg Settings
	if err := json.Unmarshal(b, &cfg); err != nil {
		return Settings{}, false, err
	}
	return cfg, true, nil
}

func SaveSettings(path string, cfg Settings) error {
	if path == "" {
		return errors.New("path is empty")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(b, '\n'), 0o644)
}
