package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"sync"
	"time"
)

// time.Parse accepts RFC 3339; the pattern pins the exact shape both
// implementations accept, so a grant file loads in one only if it loads in both.
var rfc3339 = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$`)

type grantSpec struct {
	RunID     *string   `json:"runId"`
	Token     *string   `json:"token"`
	Tools     *[]string `json:"tools"`
	Approve   *[]string `json:"approve"`
	ExpiresAt *string   `json:"expiresAt"`
	MaxCalls  *float64  `json:"maxCalls"`
}

type grant struct {
	runID     string
	tools     map[string]bool
	approve   map[string]bool
	expiresAt time.Time
	maxCalls  int
	used      int // guarded by grantStore.mu
}

type grantStore struct {
	mu      sync.Mutex
	byToken map[string]*grant // sha256(token) -> grant; the raw token is never kept
}

func newGrantStore() *grantStore { return &grantStore{byToken: map[string]*grant{}} }

func tokenKey(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func set(list []string) map[string]bool {
	out := make(map[string]bool, len(list))
	for _, t := range list {
		out[t] = true
	}
	return out
}

func parseGrant(raw json.RawMessage) (*grant, string, error) {
	var s grantSpec
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, "", errors.New("grant must be an object of the documented shape")
	}
	switch {
	case s.RunID == nil || *s.RunID == "":
		return nil, "", errors.New("runId must be a non-empty string")
	case s.Token == nil || len(*s.Token) < 16:
		return nil, "", errors.New("token must be at least 16 characters")
	case s.Tools == nil:
		return nil, "", errors.New("tools must be an array of strings")
	case s.ExpiresAt == nil || !rfc3339.MatchString(*s.ExpiresAt):
		return nil, "", errors.New("expiresAt must be an RFC 3339 timestamp")
	case s.MaxCalls == nil || *s.MaxCalls < 1 || *s.MaxCalls != float64(int(*s.MaxCalls)):
		return nil, "", errors.New("maxCalls must be a positive integer")
	}
	expires, err := time.Parse(time.RFC3339Nano, *s.ExpiresAt)
	if err != nil {
		return nil, "", errors.New("expiresAt must be an RFC 3339 timestamp")
	}
	g := &grant{
		runID:     *s.RunID,
		tools:     set(*s.Tools),
		approve:   map[string]bool{},
		expiresAt: expires,
		maxCalls:  int(*s.MaxCalls),
	}
	if s.Approve != nil {
		g.approve = set(*s.Approve)
	}
	return g, *s.Token, nil
}

// add returns the runId, or an HTTP status and the reason the grant was rejected.
func (s *grantStore) add(raw json.RawMessage) (string, int, error) {
	g, token, err := parseGrant(raw)
	if err != nil {
		return "", http.StatusBadRequest, err
	}
	key := tokenKey(token)
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.byToken[key]; exists {
		return "", http.StatusConflict, errors.New("a grant with this token exists")
	}
	s.byToken[key] = g
	return g.runID, 0, nil
}

func (s *grantStore) find(token string) *grant {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.byToken[tokenKey(token)]
}

// usable reports why a grant may not be used now, or "" when it may.
func (s *grantStore) usable(g *grant) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !time.Now().Before(g.expiresAt) {
		return "expired"
	}
	if g.used >= g.maxCalls {
		return "max_calls"
	}
	return ""
}

// admit runs the call checks and reserves a call slot in one critical
// section, so concurrent calls cannot overspend maxCalls.
func (s *grantStore) admit(g *grant, tool string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !time.Now().Before(g.expiresAt) {
		return "expired"
	}
	if !g.tools[tool] {
		return "not_granted"
	}
	if g.used >= g.maxCalls {
		return "max_calls"
	}
	g.used++
	return ""
}

type pendingApproval struct {
	ID         string          `json:"id"`
	RunID      string          `json:"runId"`
	Tool       string          `json:"tool"`
	Arguments  json.RawMessage `json:"arguments"`
	ArgsDigest string          `json:"argsDigest"`
	CreatedAt  string          `json:"createdAt"`
	decision   chan string
}

type approvals struct {
	mu      sync.Mutex
	timeout time.Duration
	order   []string
	pending map[string]*pendingApproval
}

func newApprovals(timeout time.Duration) *approvals {
	return &approvals{timeout: timeout, pending: map[string]*pendingApproval{}}
}

func (a *approvals) remove(id string) bool {
	if _, ok := a.pending[id]; !ok {
		return false
	}
	delete(a.pending, id)
	for i, v := range a.order {
		if v == id {
			a.order = append(a.order[:i], a.order[i+1:]...)
			break
		}
	}
	return true
}

// hold blocks until "allow", "deny" or "timeout". Whichever of decide and the
// timer takes the entry out of the map first wins; the other is a no-op.
func (a *approvals) hold(p *pendingApproval) string {
	idBytes := make([]byte, 12)
	_, _ = rand.Read(idBytes)
	p.ID = hex.EncodeToString(idBytes)
	p.CreatedAt = nowISO()
	p.decision = make(chan string, 1)
	a.mu.Lock()
	a.pending[p.ID] = p
	a.order = append(a.order, p.ID)
	a.mu.Unlock()

	timer := time.NewTimer(a.timeout)
	defer timer.Stop()
	select {
	case d := <-p.decision:
		return d
	case <-timer.C:
		a.mu.Lock()
		removed := a.remove(p.ID)
		a.mu.Unlock()
		if removed {
			return "timeout"
		}
		return <-p.decision // a decision landed between the timer and the lock
	}
}

func (a *approvals) list() []*pendingApproval {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]*pendingApproval, 0, len(a.order))
	for _, id := range a.order {
		out = append(out, a.pending[id])
	}
	return out
}

func (a *approvals) decide(id, decision string) bool {
	a.mu.Lock()
	p, ok := a.pending[id]
	if ok {
		a.remove(id)
	}
	a.mu.Unlock()
	if ok {
		p.decision <- decision
	}
	return ok
}

func nowISO() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00") }
