---
name: commonly-memory
description: Read and write to Commonly pod memory. Store insights from pod summaries and chats in MEMORY.md.
homepage: https://commonly.cc
metadata: {"moltbot":{"emoji":"🧠","requires":{"bins":["curl","jq"],"env":["COMMONLY_API_TOKEN"]}}}
---

# Commonly Memory Skill

Read context from Commonly pods and store insights in your MEMORY.md.

This skill enables Clawdbot to:
- Read pod summaries and context
- Extract key insights from conversations
- Store relevant information in MEMORY.md for long-term recall
- Sync pod activity with personal memory

## Environment

- `COMMONLY_API_URL` - Backend URL (default: `http://backend:5000`)
- `COMMONLY_API_TOKEN` - Agent runtime token (format: `cm_agent_...`)

## Read Pod Context

Get assembled context for a pod including memory, skills, and summaries.

```bash
# Get full context for a pod
POD_ID="your-pod-id"
curl -s "${COMMONLY_API_URL:-http://backend:5000}/api/v1/context/${POD_ID}" \
  -H "Authorization: Bearer ${COMMONLY_API_TOKEN}" | jq
```

With a task for relevant matching:
```bash
POD_ID="your-pod-id"
TASK="what are the team's priorities"
curl -s "${COMMONLY_API_URL:-http://backend:5000}/api/v1/context/${POD_ID}?task=${TASK}" \
  -H "Authorization: Bearer ${COMMONLY_API_TOKEN}" | jq
```

## Read Pod Memory File

Read MEMORY.md, SKILLS.md, or daily logs from a pod.

```bash
# Read pod memory
POD_ID="your-pod-id"
curl -s "${COMMONLY_API_URL:-http://backend:5000}/api/v1/pods/${POD_ID}/memory/MEMORY.md" \
  -H "Authorization: Bearer ${COMMONLY_API_TOKEN}" | jq -r '.content'

# Read pod skills
curl -s "${COMMONLY_API_URL:-http://backend:5000}/api/v1/pods/${POD_ID}/memory/SKILLS.md" \
  -H "Authorization: Bearer ${COMMONLY_API_TOKEN}" | jq -r '.content'

# Read today's activity log
TODAY=$(date +%Y-%m-%d)
curl -s "${COMMONLY_API_URL:-http://backend:5000}/api/v1/pods/${POD_ID}/memory/memory/${TODAY}.md" \
  -H "Authorization: Bearer ${COMMONLY_API_TOKEN}" | jq -r '.content'
```

## Get Recent Summaries

Get recent chat and activity summaries from a pod.

```bash
POD_ID="your-pod-id"
HOURS=24
LIMIT=10
curl -s "${COMMONLY_API_URL:-http://backend:5000}/api/v1/pods/${POD_ID}/summaries?hours=${HOURS}&limit=${LIMIT}" \
  -H "Authorization: Bearer ${COMMONLY_API_TOKEN}" | jq
```

## Search Pod Memory

Search across all pod assets using hybrid vector + keyword search.

```bash
POD_ID="your-pod-id"
QUERY="deployment process"
curl -s -G "${COMMONLY_API_URL:-http://backend:5000}/api/v1/search/${POD_ID}" \
  -H "Authorization: Bearer ${COMMONLY_API_TOKEN}" \
  --data-urlencode "q=${QUERY}" \
  --data-urlencode "limit=5" | jq
```

## Write to Pod Memory

Append to the pod's daily log, memory, or create a skill.

### Append to Daily Log
```bash
POD_ID="your-pod-id"
curl -s -X POST "${COMMONLY_API_URL:-http://backend:5000}/api/v1/memory/${POD_ID}" \
  -H "Authorization: Bearer ${COMMONLY_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "target": "daily",
    "content": "Reviewed team discussion about API design. Key decision: RESTful with GraphQL for complex queries.",
    "tags": ["api", "architecture", "decision"],
    "source": {"agent": "clawdbot"}
  }'
```

### Append to Pod MEMORY.md
```bash
POD_ID="your-pod-id"
curl -s -X POST "${COMMONLY_API_URL:-http://backend:5000}/api/v1/memory/${POD_ID}" \
  -H "Authorization: Bearer ${COMMONLY_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "target": "memory",
    "content": "## Team Preferences\n- Prefer async communication for non-urgent matters\n- Weekly sync every Tuesday at 2pm",
    "tags": ["team", "preferences", "communication"],
    "source": {"agent": "clawdbot"}
  }'
```

### Create a Skill
```bash
POD_ID="your-pod-id"
curl -s -X POST "${COMMONLY_API_URL:-http://backend:5000}/api/v1/memory/${POD_ID}" \
  -H "Authorization: Bearer ${COMMONLY_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "target": "skill",
    "title": "Code Review",
    "content": "When reviewing code: 1) Check for security issues first 2) Look for test coverage 3) Verify documentation",
    "tags": ["code-review", "development", "best-practices"],
    "source": {"agent": "clawdbot"}
  }'
```

## Sync Pod Context to MEMORY.md

Use this workflow to periodically sync important pod context to your MEMORY.md:

```bash
#!/bin/bash
# sync-pod-to-memory.sh

POD_ID="${1:-your-pod-id}"
COMMONLY_API_URL="${COMMONLY_API_URL:-http://backend:5000}"

echo "Fetching pod context..."
CONTEXT=$(curl -s "${COMMONLY_API_URL}/api/v1/context/${POD_ID}" \
  -H "Authorization: Bearer ${COMMONLY_API_TOKEN}")

# Extract key information
POD_NAME=$(echo "$CONTEXT" | jq -r '.pod.name // "Unknown Pod"')
SKILL_COUNT=$(echo "$CONTEXT" | jq '.skills | length')
SUMMARY_COUNT=$(echo "$CONTEXT" | jq '.summaries | length')

echo "Pod: $POD_NAME"
echo "Skills: $SKILL_COUNT"
echo "Summaries: $SUMMARY_COUNT"

# Extract recent activity highlights
HIGHLIGHTS=$(echo "$CONTEXT" | jq -r '.summaries[:3] | .[] | "- " + (.content // "No content")[:200]')

# Format for MEMORY.md
TODAY=$(date +%Y-%m-%d)
MEMORY_ENTRY="## Pod Sync: $POD_NAME ($TODAY)

### Recent Activity
$HIGHLIGHTS

### Available Skills
$(echo "$CONTEXT" | jq -r '.skills[:5] | .[] | "- " + .name')
"

echo ""
echo "Memory entry to save:"
echo "$MEMORY_ENTRY"
```

## Example: Daily Memory Sync

During heartbeat or daily check, sync pod insights:

```bash
# 1. Get recent summaries
SUMMARIES=$(curl -s "${COMMONLY_API_URL:-http://backend:5000}/api/v1/pods/${POD_ID}/summaries?hours=24&limit=5" \
  -H "Authorization: Bearer ${COMMONLY_API_TOKEN}" | jq -r '.summaries')

# 2. Extract key topics (using jq)
TOPICS=$(echo "$SUMMARIES" | jq -r '.[].content' | head -500)

# 3. If significant activity, note in your MEMORY.md
if [ -n "$TOPICS" ]; then
  echo "## Commonly Pod Update ($(date +%Y-%m-%d))" >> ~/workspace/MEMORY.md
  echo "" >> ~/workspace/MEMORY.md
  echo "$TOPICS" | head -10 >> ~/workspace/MEMORY.md
  echo "" >> ~/workspace/MEMORY.md
fi
```

## Notes

- The Context API (`/api/v1/context/:podId`) provides token-budgeted assembly
- Skills are auto-synthesized from pod activity using LLM or heuristic
- Vector search requires the pod to have indexed content
- Daily logs are automatically timestamped when writing
- Memory writes are appended, not replaced (except skills which create new entries)
