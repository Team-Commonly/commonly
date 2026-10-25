package main

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
)

const (
	maxBodyBytes    = 1 << 20
	upstreamTimeout = 30 * time.Second

	codeParse          = -32700
	codeInvalidRequest = -32600
	codeMethodNotFound = -32601
	codeInvalidParams  = -32602
	codeUnauthorized   = -32001
	codeUpstream       = -32002
	codeRefused        = -32003
)

var protocolVersions = []string{"2025-06-18", "2025-03-26"}

type rpcError struct {
	Code    int               `json:"code"`
	Message string            `json:"message"`
	Data    map[string]string `json:"data,omitempty"`
}

func (e *rpcError) Error() string { return e.Message }

func refusal(reason string) *rpcError {
	return &rpcError{Code: codeRefused, Message: "refused: " + reason, Data: map[string]string{"reason": reason}}
}

type broker struct {
	grants     *grantStore
	audit      *auditLog
	approvals  *approvals
	upstream   *upstream
	adminToken string
}

// ---- upstream -------------------------------------------------------------

type upstream struct {
	url        string
	credential string
	client     *http.Client
	nextID     atomic.Int64
}

func newUpstream(url, credential string) *upstream {
	// The default transport keeps only 2 idle connections per host, which
	// under concurrent calls turns every request into a fresh TCP connection.
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.MaxIdleConnsPerHost = 256
	return &upstream{url: url, credential: credential, client: &http.Client{Timeout: upstreamTimeout, Transport: tr}}
}

func (u *upstream) call(method string, params any) (json.RawMessage, error) {
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": u.nextID.Add(1), "method": method, "params": params})
	req, _ := http.NewRequest(http.MethodPost, u.url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Authorization", "Bearer "+u.credential)
	res, err := u.client.Do(req)
	if err != nil {
		// No upstream detail goes back: it is the one place the credential could ride.
		return nil, &rpcError{Code: codeUpstream, Message: "upstream_unavailable"}
	}
	defer res.Body.Close()
	text, err := io.ReadAll(res.Body)
	if err != nil || res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, &rpcError{Code: codeUpstream, Message: "upstream_unavailable"}
	}
	text = bytes.ReplaceAll(text, []byte(u.credential), []byte("[redacted]"))
	var reply struct {
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Code    *int `json:"code"`
			Message any  `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(text, &reply); err != nil {
		return nil, &rpcError{Code: codeUpstream, Message: "upstream_invalid_response"}
	}
	if reply.Error != nil {
		code := codeUpstream
		if reply.Error.Code != nil {
			code = *reply.Error.Code
		}
		msg := "upstream_error"
		if reply.Error.Message != nil {
			msg = fmt.Sprint(reply.Error.Message)
		}
		return nil, &rpcError{Code: code, Message: msg}
	}
	return reply.Result, nil
}

// ---- MCP methods ----------------------------------------------------------

func (b *broker) record(g *grant, tool, decision, digest, reason string) error {
	return b.audit.write(auditEntry{TS: nowISO(), RunID: g.runID, Tool: tool, Decision: decision, Reason: reason, ArgsDigest: digest})
}

// refuse audits and returns the refusal in one step so no refusal can skip the log.
func (b *broker) refuse(g *grant, tool, digest, reason string) error {
	if err := b.record(g, tool, "refused", digest, reason); err != nil {
		return err
	}
	return refusal(reason)
}

func (b *broker) listTools(g *grant) (any, error) {
	if reason := b.grants.usable(g); reason != "" {
		return nil, refusal(reason)
	}
	result, err := b.upstream.call("tools/list", map[string]any{})
	if err != nil {
		return nil, err
	}
	var listed struct {
		Tools []json.RawMessage `json:"tools"`
	}
	_ = json.Unmarshal(result, &listed)
	tools := []json.RawMessage{}
	for _, t := range listed.Tools {
		var named struct {
			Name string `json:"name"`
		}
		if json.Unmarshal(t, &named) == nil && g.tools[named.Name] {
			tools = append(tools, t)
		}
	}
	return map[string]any{"tools": tools}, nil
}

func (b *broker) callTool(g *grant, params json.RawMessage) (any, error) {
	var p struct {
		Name      *string         `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	badParams := &rpcError{Code: codeInvalidParams, Message: "tools/call needs a string name and object arguments"}
	if len(params) > 0 && json.Unmarshal(params, &p) != nil || p.Name == nil {
		return nil, badParams
	}
	args := p.Arguments
	if len(args) == 0 || string(args) == "null" {
		args = json.RawMessage("{}")
	}
	dec := json.NewDecoder(bytes.NewReader(args))
	dec.UseNumber()
	var decoded map[string]any
	if dec.Decode(&decoded) != nil {
		return nil, badParams
	}
	tool, digest := *p.Name, argsDigest(decoded)

	if reason := b.grants.admit(g, tool); reason != "" {
		return nil, b.refuse(g, tool, digest, reason)
	}
	if g.approve[tool] {
		outcome := b.approvals.hold(&pendingApproval{RunID: g.runID, Tool: tool, Arguments: args, ArgsDigest: digest})
		if outcome != "allow" {
			decision, reason := "timeout", "approval_timeout"
			if outcome == "deny" {
				decision, reason = "denied", "approval_denied"
			}
			if err := b.record(g, tool, decision, digest, ""); err != nil {
				return nil, err
			}
			return nil, refusal(reason)
		}
		if err := b.record(g, tool, "approved", digest, ""); err != nil {
			return nil, err
		}
	} else if err := b.record(g, tool, "allowed", digest, ""); err != nil {
		return nil, err
	}
	return b.upstream.call("tools/call", map[string]any{"name": tool, "arguments": args})
}

func (b *broker) dispatch(g *grant, method string, params json.RawMessage) (any, error) {
	switch method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(params, &p)
		version := protocolVersions[0]
		for _, v := range protocolVersions {
			if v == p.ProtocolVersion {
				version = v
			}
		}
		return map[string]any{
			"protocolVersion": version,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": "grants-broker", "version": "0.1.0"},
		}, nil
	case "ping":
		return map[string]any{}, nil
	case "tools/list":
		return b.listTools(g)
	case "tools/call":
		return b.callTool(g, params)
	}
	return nil, &rpcError{Code: codeMethodNotFound, Message: "method not found: " + method}
}

// ---- HTTP -----------------------------------------------------------------

func send(w http.ResponseWriter, status int, body any) {
	if body == nil {
		w.WriteHeader(status)
		return
	}
	out, _ := json.Marshal(body)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(out)
}

func rpcErrorBody(id json.RawMessage, e *rpcError) map[string]any {
	if len(id) == 0 {
		id = json.RawMessage("null")
	}
	return map[string]any{"jsonrpc": "2.0", "id": id, "error": e}
}

func bearer(r *http.Request) string {
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok {
		return ""
	}
	return token
}

func sameSecret(a, b string) bool {
	x, y := sha256.Sum256([]byte(a)), sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(x[:], y[:]) == 1
}

var errTooLarge = errors.New("too large")

func readBody(r *http.Request) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes+1))
	if err == nil && len(body) > maxBodyBytes {
		return nil, errTooLarge
	}
	return body, err
}

func (b *broker) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/mcp" {
		if r.Method != http.MethodPost {
			send(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST only; no SSE stream is offered"})
			return
		}
		b.handleMCP(w, r)
		return
	}
	b.handleAdmin(w, r)
}

func (b *broker) handleMCP(w http.ResponseWriter, r *http.Request) {
	g := b.grants.find(bearer(r))
	if g == nil {
		send(w, http.StatusUnauthorized, rpcErrorBody(nil, &rpcError{Code: codeUnauthorized, Message: "unauthorized"}))
		return
	}
	body, err := readBody(r)
	if err == errTooLarge {
		send(w, http.StatusRequestEntityTooLarge, rpcErrorBody(nil, &rpcError{Code: codeInvalidRequest, Message: "body too large"}))
		return
	}
	if err != nil || !json.Valid(body) {
		send(w, http.StatusBadRequest, rpcErrorBody(nil, &rpcError{Code: codeParse, Message: "parse error"}))
		return
	}
	var msg map[string]json.RawMessage
	var version, method string
	invalid := json.Unmarshal(body, &msg) != nil ||
		json.Unmarshal(msg["jsonrpc"], &version) != nil || version != "2.0" ||
		json.Unmarshal(msg["method"], &method) != nil
	if invalid {
		send(w, http.StatusBadRequest, rpcErrorBody(msg["id"], &rpcError{Code: codeInvalidRequest, Message: "invalid request"}))
		return
	}
	id, hasID := msg["id"]
	if !hasID {
		send(w, http.StatusAccepted, nil) // notification: accepted, no body
		return
	}
	result, err := b.dispatch(g, method, msg["params"])
	if err != nil {
		var known *rpcError
		if !errors.As(err, &known) {
			known = &rpcError{Code: codeUpstream, Message: "internal_error"}
		}
		send(w, http.StatusOK, rpcErrorBody(id, known))
		return
	}
	send(w, http.StatusOK, map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

func (b *broker) handleAdmin(w http.ResponseWriter, r *http.Request) {
	if !sameSecret(bearer(r), b.adminToken) {
		send(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if r.Method == http.MethodGet && r.URL.Path == "/approvals" {
		send(w, http.StatusOK, map[string]any{"approvals": b.approvals.list()})
		return
	}
	body, err := readBody(r)
	if err != nil {
		send(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if len(body) == 0 {
		body = []byte("{}")
	}
	if !json.Valid(body) {
		send(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if r.Method == http.MethodPost && r.URL.Path == "/grants" {
		runID, status, err := b.grants.add(body)
		if err != nil {
			send(w, status, map[string]string{"error": err.Error()})
			return
		}
		send(w, http.StatusCreated, map[string]string{"runId": runID})
		return
	}
	if id, ok := strings.CutPrefix(r.URL.Path, "/approvals/"); ok && r.Method == http.MethodPost && id != "" && !strings.Contains(id, "/") {
		var d struct {
			Decision string `json:"decision"`
		}
		_ = json.Unmarshal(body, &d)
		if d.Decision != "allow" && d.Decision != "deny" {
			send(w, http.StatusBadRequest, map[string]string{"error": "decision must be allow or deny"})
			return
		}
		if !b.approvals.decide(id, d.Decision) {
			send(w, http.StatusNotFound, map[string]string{"error": "no such pending approval"})
			return
		}
		send(w, http.StatusOK, map[string]string{"id": id, "decision": d.Decision})
		return
	}
	send(w, http.StatusNotFound, map[string]string{"error": "not found"})
}
