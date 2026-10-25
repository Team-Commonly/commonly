// Command broker is the grants broker, Go implementation. An MCP Streamable
// HTTP endpoint (JSON responses, no SSE) that forwards to one upstream MCP
// server under a per-run scoped grant. Standard library only, so the build has
// no go.sum to trust.
//
// Usage: broker --config <file>
// Env:   GRANTS_UPSTREAM_CREDENTIAL, GRANTS_ADMIN_TOKEN (kept out of the file)
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"syscall"
	"time"
)

// The credential is redacted from upstream bodies by plain byte replacement,
// which is only sound when JSON encoding cannot change its text.
var credentialShape = regexp.MustCompile(`^[A-Za-z0-9._~-]{16,}$`)

type config struct {
	Listen            string            `json:"listen"`
	UpstreamURL       string            `json:"upstreamUrl"`
	AuditPath         string            `json:"auditPath"`
	ApprovalTimeoutMs int               `json:"approvalTimeoutMs"`
	Grants            []json.RawMessage `json:"grants"`
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "grants-broker: "+format+"\n", args...)
	os.Exit(2)
}

func main() {
	path := flag.String("config", "", "config file")
	flag.Parse()
	if *path == "" {
		fail("usage: broker --config <file>")
	}
	raw, err := os.ReadFile(*path)
	if err != nil {
		fail("cannot read config: %v", err)
	}
	var cfg config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		fail("cannot read config: %v", err)
	}
	credential := os.Getenv("GRANTS_UPSTREAM_CREDENTIAL")
	adminToken := os.Getenv("GRANTS_ADMIN_TOKEN")
	if !credentialShape.MatchString(credential) {
		fail("GRANTS_UPSTREAM_CREDENTIAL must be 16+ chars of [A-Za-z0-9._~-]")
	}
	if len(adminToken) < 16 {
		fail("GRANTS_ADMIN_TOKEN must be at least 16 characters")
	}
	if cfg.UpstreamURL == "" || cfg.AuditPath == "" {
		fail("config needs upstreamUrl and auditPath")
	}

	grants := newGrantStore()
	for _, g := range cfg.Grants {
		if _, _, err := grants.add(g); err != nil {
			fail("grant: %v", err)
		}
	}
	audit, err := openAudit(cfg.AuditPath)
	if err != nil {
		fail("cannot open audit log: %v", err)
	}
	timeout := 60 * time.Second
	if cfg.ApprovalTimeoutMs > 0 {
		timeout = time.Duration(cfg.ApprovalTimeoutMs) * time.Millisecond
	}
	b := &broker{
		grants:     grants,
		audit:      audit,
		approvals:  newApprovals(timeout),
		upstream:   newUpstream(cfg.UpstreamURL, credential),
		adminToken: adminToken,
	}

	listen := cfg.Listen
	if listen == "" {
		listen = "127.0.0.1:0"
	}
	ln, err := net.Listen("tcp", listen)
	if err != nil {
		fail("listen: %v", err)
	}
	srv := &http.Server{Handler: b, ReadHeaderTimeout: 10 * time.Second}
	out, _ := json.Marshal(map[string]string{"listening": ln.Addr().String()})
	fmt.Println(string(out))

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-stop
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}()
	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		fail("serve: %v", err)
	}
	audit.close()
}
