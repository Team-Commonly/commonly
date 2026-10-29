package protocol

// Every fixture in schema/fixtures/<Def>/ round-trips through the generated Go types
// (spec §3 L0 done-test). valid-* must decode and re-encode to the same JSON;
// invalid-required-* must be rejected. Other invalid-* cases are lengths, patterns and
// enums, which only ajv checks (scripts/check-fixtures.mjs).

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const fixtureDir = "../../../schema/fixtures"

func TestFixturesRoundTrip(t *testing.T) {
	defs, err := os.ReadDir(fixtureDir)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, d := range defs {
		newValue, ok := Registry[d.Name()]
		if !ok {
			t.Errorf("fixtures/%s: no generated type of that name", d.Name())
			continue
		}
		files, _ := filepath.Glob(filepath.Join(fixtureDir, d.Name(), "*.json"))
		for _, f := range files {
			name := d.Name() + "/" + filepath.Base(f)
			raw, err := os.ReadFile(f)
			if err != nil {
				t.Fatal(err)
			}
			v := newValue()
			decodeErr := json.Unmarshal(raw, v)
			switch base := filepath.Base(f); {
			case strings.HasPrefix(base, "valid-"):
				if decodeErr != nil {
					t.Errorf("%s: %v", name, decodeErr)
					continue
				}
				assertSameJSON(t, name, raw, v)
				if env, ok := v.(*Envelope); ok {
					data, err := DecodeEventData(env.Type, env.Data)
					if err != nil {
						t.Errorf("%s: data: %v", name, err)
						continue
					}
					assertSameJSON(t, name+" data", env.Data, data)
				}
			case strings.HasPrefix(base, "invalid-required-"):
				if decodeErr == nil {
					t.Errorf("%s: decoded, want a missing-required-field error", name)
				}
			}
			n++
		}
	}
	if n == 0 {
		t.Fatal("no fixtures found")
	}
}

func assertSameJSON(t *testing.T, name string, want []byte, v any) {
	t.Helper()
	got, err := json.Marshal(v)
	if err != nil {
		t.Errorf("%s: marshal: %v", name, err)
		return
	}
	var a, b any
	if err := json.Unmarshal(want, &a); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	if err := json.Unmarshal(got, &b); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	if !reflect.DeepEqual(a, b) {
		t.Errorf("%s: round trip changed the JSON\nwant %s\ngot  %s", name, want, got)
	}
}
