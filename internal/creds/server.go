package creds

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"

	"github.com/levinkeller/hatchery/internal/zerg"
)

// SocketManager manages per-drone Unix socket HTTP servers.
type SocketManager struct {
	socketDir     string
	tokenProvider *TokenProvider

	mu      sync.Mutex
	sockets map[string]*socketEntry // drone name -> entry
}

type socketEntry struct {
	listener net.Listener
	server   *http.Server
	repos    []string
}

// NewSocketManager creates a new socket manager.
func NewSocketManager(socketDir string, tp *TokenProvider) *SocketManager {
	return &SocketManager{
		socketDir:     socketDir,
		tokenProvider: tp,
		sockets:       make(map[string]*socketEntry),
	}
}

// CreateSocket creates a Unix socket for a drone and starts an HTTP server on it.
func (sm *SocketManager) CreateSocket(droneName string, repos []string) error {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	if _, exists := sm.sockets[droneName]; exists {
		return nil // already exists
	}

	socketPath := filepath.Join(sm.socketDir, droneName+".sock")

	// Remove stale socket file if it exists
	os.Remove(socketPath)

	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return fmt.Errorf("listening on %s: %w", socketPath, err)
	}

	// Make socket world-readable so container processes can connect
	if err := os.Chmod(socketPath, 0666); err != nil {
		listener.Close()
		return fmt.Errorf("chmod socket: %w", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		token, err := sm.tokenProvider.GetToken(repos)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/plain")
		fmt.Fprint(w, token)
	})

	srv := &http.Server{Handler: mux}
	entry := &socketEntry{
		listener: listener,
		server:   srv,
		repos:    repos,
	}

	sm.sockets[droneName] = entry

	go func() {
		if err := srv.Serve(listener); err != nil && err != http.ErrServerClosed {
			fmt.Fprintf(os.Stderr, "socket server error for %s: %v\n", droneName, err)
		}
	}()

	zerg.Printf("%s [%s]", zerg.MsgSocketCreated, droneName)
	return nil
}

// RemoveSocket stops the HTTP server and removes the socket file for a drone.
func (sm *SocketManager) RemoveSocket(droneName string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	entry, exists := sm.sockets[droneName]
	if !exists {
		return
	}

	entry.server.Close()
	delete(sm.sockets, droneName)

	socketPath := filepath.Join(sm.socketDir, droneName+".sock")
	os.Remove(socketPath)

	zerg.Printf("%s [%s]", zerg.MsgSocketRemoved, droneName)
}

// Shutdown gracefully closes all sockets.
func (sm *SocketManager) Shutdown(ctx context.Context) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	for name, entry := range sm.sockets {
		entry.server.Shutdown(ctx)
		socketPath := filepath.Join(sm.socketDir, name+".sock")
		os.Remove(socketPath)
	}
	sm.sockets = make(map[string]*socketEntry)
}
