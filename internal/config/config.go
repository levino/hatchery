package config

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

// loadEnvFile reads a .env file and sets any variables not already in the environment.
// Missing file is not an error. Existing env vars take precedence.
func loadEnvFile(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || line[0] == '#' {
			continue
		}
		key, val, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		val = strings.TrimSpace(val)
		// Strip matching quotes
		if len(val) >= 2 && ((val[0] == '"' && val[len(val)-1] == '"') || (val[0] == '\'' && val[len(val)-1] == '\'')) {
			val = val[1 : len(val)-1]
		}
		// Don't override existing env vars
		if _, exists := os.LookupEnv(key); !exists {
			os.Setenv(key, val)
		}
	}
}

type Config struct {
	GitHubAppID          string
	GitHubAppPrivateKey  string // PEM-encoded private key contents
	GitHubInstallationID string
	HeadscaleAuthKey     string
	TailscaleDomain      string // e.g. "tail.levinkeller.de"
	SocketDir            string // e.g. "/var/run/hatchery"
}

func Load() (*Config, error) {
	loadEnvFile(".env")
	loadEnvFile("/etc/hatchery.env")

	cfg := &Config{
		GitHubAppID:          os.Getenv("HATCHERY_GITHUB_APP_ID"),
		GitHubAppPrivateKey:  os.Getenv("HATCHERY_GITHUB_APP_KEY"),
		GitHubInstallationID: os.Getenv("HATCHERY_GITHUB_INSTALLATION_ID"),
		HeadscaleAuthKey:     os.Getenv("HATCHERY_HEADSCALE_AUTH_KEY"),
		TailscaleDomain:      os.Getenv("HATCHERY_TAILSCALE_DOMAIN"),
		SocketDir:            os.Getenv("HATCHERY_SOCKET_DIR"),
	}

	if cfg.TailscaleDomain == "" {
		cfg.TailscaleDomain = "tail.levinkeller.de"
	}
	if cfg.SocketDir == "" {
		cfg.SocketDir = "/var/run/hatchery"
	}

	// If key looks like a file path, read it
	if len(cfg.GitHubAppPrivateKey) > 0 && cfg.GitHubAppPrivateKey[0] == '/' {
		data, err := os.ReadFile(cfg.GitHubAppPrivateKey)
		if err != nil {
			return nil, fmt.Errorf("reading private key file: %w", err)
		}
		cfg.GitHubAppPrivateKey = string(data)
	}

	return cfg, nil
}

// RequireCredentials validates that all GitHub App fields are set.
func (c *Config) RequireCredentials() error {
	if c.GitHubAppID == "" {
		return fmt.Errorf("HATCHERY_GITHUB_APP_ID not set")
	}
	if c.GitHubAppPrivateKey == "" {
		return fmt.Errorf("HATCHERY_GITHUB_APP_KEY not set")
	}
	if c.GitHubInstallationID == "" {
		return fmt.Errorf("HATCHERY_GITHUB_INSTALLATION_ID not set")
	}
	return nil
}
