package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"sort"
	"sync"
)

type auditEntry struct {
	TS         string `json:"ts"`
	RunID      string `json:"runId"`
	Tool       string `json:"tool"`
	Decision   string `json:"decision"`
	Reason     string `json:"reason,omitempty"`
	ArgsDigest string `json:"argsDigest"`
}

type auditLog struct {
	mu sync.Mutex
	f  *os.File
}

func openAudit(path string) (*auditLog, error) {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	// A pre-existing file keeps its old mode on open; tighten it either way.
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return nil, err
	}
	return &auditLog{f: f}, nil
}

func (a *auditLog) write(e auditEntry) error {
	line, err := json.Marshal(e)
	if err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	_, err = a.f.Write(append(line, '\n'))
	return err
}

func (a *auditLog) close() { a.f.Close() }

// argsDigest hashes the arguments with keys sorted at every depth, so the
// digest names the arguments, not the order a client serialised them in.
func argsDigest(v any) string {
	var buf bytes.Buffer
	writeCanonical(&buf, v)
	sum := sha256.Sum256(buf.Bytes())
	return hex.EncodeToString(sum[:])
}

func writeCanonical(buf *bytes.Buffer, v any) {
	switch t := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		buf.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				buf.WriteByte(',')
			}
			writeString(buf, k)
			buf.WriteByte(':')
			writeCanonical(buf, t[k])
		}
		buf.WriteByte('}')
	case []any:
		buf.WriteByte('[')
		for i, item := range t {
			if i > 0 {
				buf.WriteByte(',')
			}
			writeCanonical(buf, item)
		}
		buf.WriteByte(']')
	case string:
		writeString(buf, t)
	case json.Number:
		buf.WriteString(t.String())
	default: // bool, nil
		out, _ := json.Marshal(t)
		buf.Write(out)
	}
}

func writeString(buf *bytes.Buffer, s string) {
	enc := json.NewEncoder(buf)
	enc.SetEscapeHTML(false) // match JSON.stringify for <, > and &
	_ = enc.Encode(s)
	buf.Truncate(buf.Len() - 1) // Encode appends a newline
}
