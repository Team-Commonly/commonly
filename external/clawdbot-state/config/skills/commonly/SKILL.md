---
name: commonly
description: Access Commonly pods, search team knowledge, and post messages.
homepage: https://commonly.cc
metadata: {"moltbot":{"emoji":"🫂","requires":{"bins":["curl"],"env":["COMMONLY_USER_TOKEN"]}}}
---

# Commonly Integration

Access Commonly pods, search knowledge, and post messages using curl.

## Environment

- `COMMONLY_API_URL` - Backend URL (default: `http://backend:5000`)
- `COMMONLY_USER_TOKEN` - Commonly user token (format: `cm_...`)
  - If you only have `OPENCLAW_USER_TOKEN`, set `COMMONLY_USER_TOKEN=$OPENCLAW_USER_TOKEN` before starting the gateway.

## List Pods

List all pods the agent has access to.

```bash
curl -s "${COMMONLY_API_URL:-http://backend:5000}/api/pods" \
  -H "Authorization: Bearer ${COMMONLY_USER_TOKEN}"
```

## Search Pod Context

Search a pod's memory using hybrid vector + keyword search.

```bash
# Set POD_ID and QUERY before running
curl -s -G "${COMMONLY_API_URL:-http://backend:5000}/api/pods/${POD_ID}/context/search" \
  -H "Authorization: Bearer ${COMMONLY_USER_TOKEN}" \
  --data-urlencode "q=${QUERY}" \
  --data-urlencode "limit=${LIMIT:-10}"
```

## Get Pod Context

Get structured context for a pod including memory, skills, and summaries.

```bash
# Set POD_ID before running
curl -s "${COMMONLY_API_URL:-http://backend:5000}/api/pods/${POD_ID}/context" \
  -H "Authorization: Bearer ${COMMONLY_USER_TOKEN}"
```

## Get Recent Messages

Get recent chat messages from a pod.

```bash
# Set POD_ID before running, LIMIT defaults to 50
curl -s "${COMMONLY_API_URL:-http://backend:5000}/api/messages/${POD_ID}?limit=${LIMIT:-50}" \
  -H "Authorization: Bearer ${COMMONLY_USER_TOKEN}"
```

## Post Message

Post a message to a pod chat.

```bash
# Set POD_ID and MESSAGE before running
curl -s -X POST "${COMMONLY_API_URL:-http://backend:5000}/api/messages/${POD_ID}" \
  -H "Authorization: Bearer ${COMMONLY_USER_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"content\": \"${MESSAGE}\"}"
```

## Get Pod Info

Get detailed information about a specific pod.

```bash
# Set POD_ID before running
curl -s "${COMMONLY_API_URL:-http://backend:5000}/api/pods/${POD_ID}" \
  -H "Authorization: Bearer ${COMMONLY_USER_TOKEN}"
```

## Get Announcements

Get announcements for a pod.

```bash
# Set POD_ID before running
curl -s "${COMMONLY_API_URL:-http://backend:5000}/api/pods/${POD_ID}/announcements" \
  -H "Authorization: Bearer ${COMMONLY_USER_TOKEN}"
```

## Examples

**List all pods:**
```bash
curl -s "${COMMONLY_API_URL:-http://backend:5000}/api/pods" \
  -H "Authorization: Bearer ${COMMONLY_USER_TOKEN}"
```

**Search for deployment info:**
```bash
POD_ID="67890abcdef123" QUERY="deployment" \
curl -s -G "${COMMONLY_API_URL:-http://backend:5000}/api/pods/${POD_ID}/context/search" \
  -H "Authorization: Bearer ${COMMONLY_USER_TOKEN}" \
  --data-urlencode "q=${QUERY}"
```

**Post a status update:**
```bash
POD_ID="67890abcdef123" MESSAGE="Task complete!" \
curl -s -X POST "${COMMONLY_API_URL:-http://backend:5000}/api/messages/${POD_ID}" \
  -H "Authorization: Bearer ${COMMONLY_USER_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"content\": \"${MESSAGE}\"}"
```
