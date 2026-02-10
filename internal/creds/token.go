package creds

import (
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// TokenProvider generates scoped GitHub App installation access tokens.
type TokenProvider struct {
	appID          string
	installationID string
	privateKey     *rsa.PrivateKey

	mu    sync.Mutex
	cache map[string]cachedToken // key = sorted repo names
}

type cachedToken struct {
	Token     string
	ExpiresAt time.Time
}

// NewTokenProvider creates a token provider from config values.
func NewTokenProvider(appID, installationID, privateKeyPEM string) (*TokenProvider, error) {
	block, _ := pem.Decode([]byte(privateKeyPEM))
	if block == nil {
		return nil, fmt.Errorf("failed to decode PEM block from private key")
	}

	key, err := x509.ParsePKCS1PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parsing private key: %w", err)
	}

	return &TokenProvider{
		appID:          appID,
		installationID: installationID,
		privateKey:     key,
		cache:          make(map[string]cachedToken),
	}, nil
}

// GetToken returns a scoped installation access token for the given repos.
// Returns a cached token if >5min remaining, otherwise generates a new one.
func (tp *TokenProvider) GetToken(repos []string) (string, error) {
	key := cacheKey(repos)

	tp.mu.Lock()
	defer tp.mu.Unlock()

	if cached, ok := tp.cache[key]; ok {
		if time.Until(cached.ExpiresAt) > 5*time.Minute {
			return cached.Token, nil
		}
	}

	token, expiresAt, err := tp.createInstallationToken(repos)
	if err != nil {
		return "", err
	}

	tp.cache[key] = cachedToken{Token: token, ExpiresAt: expiresAt}
	return token, nil
}

// createJWT creates a short-lived JWT signed with the app's private key.
func (tp *TokenProvider) createJWT() (string, error) {
	now := time.Now()
	claims := jwt.RegisteredClaims{
		IssuedAt:  jwt.NewNumericDate(now.Add(-60 * time.Second)),
		ExpiresAt: jwt.NewNumericDate(now.Add(10 * time.Minute)),
		Issuer:    tp.appID,
	}

	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	return token.SignedString(tp.privateKey)
}

// createInstallationToken calls GitHub API to create a scoped installation token.
func (tp *TokenProvider) createInstallationToken(repos []string) (string, time.Time, error) {
	jwtToken, err := tp.createJWT()
	if err != nil {
		return "", time.Time{}, fmt.Errorf("creating JWT: %w", err)
	}

	url := fmt.Sprintf("https://api.github.com/app/installations/%s/access_tokens", tp.installationID)

	body := map[string]any{
		"repositories": repoNames(repos),
	}
	bodyJSON, _ := json.Marshal(body)

	req, err := http.NewRequest("POST", url, strings.NewReader(string(bodyJSON)))
	if err != nil {
		return "", time.Time{}, err
	}
	req.Header.Set("Authorization", "Bearer "+jwtToken)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("GitHub API request: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusCreated {
		return "", time.Time{}, fmt.Errorf("GitHub API returned %d: %s", resp.StatusCode, string(respBody))
	}

	var result struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return "", time.Time{}, fmt.Errorf("parsing response: %w", err)
	}

	return result.Token, result.ExpiresAt, nil
}

// cacheKey returns a stable key for a set of repos.
func cacheKey(repos []string) string {
	sorted := make([]string, len(repos))
	copy(sorted, repos)
	sort.Strings(sorted)
	return strings.Join(sorted, ",")
}

// repoNames extracts just the repo name (without org) from "org/repo" strings.
func repoNames(repos []string) []string {
	names := make([]string, len(repos))
	for i, r := range repos {
		parts := strings.SplitN(r, "/", 2)
		if len(parts) == 2 {
			names[i] = parts[1]
		} else {
			names[i] = r
		}
	}
	return names
}
