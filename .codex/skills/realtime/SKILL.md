---

name: realtime
description: Real-time systems context for Socket.io, WebSockets, and event-driven architecture. Use when working on chat, live updates, or real-time features.
last_updated: 2026-02-04
---

# Real-time Systems

**Technologies**: Socket.io, WebSockets, Event-driven Architecture

## Required Knowledge
- Socket.io server and client setup
- Room-based messaging
- Event handling and broadcasting
- Connection management
- Real-time state synchronization

## Relevant Documentation

| Document | Topics Covered |
|----------|----------------|
| [BACKEND.md](../../../docs/development/BACKEND.md) | Socket.io integration, events |
| [FRONTEND.md](../../../docs/development/FRONTEND.md) | useSocket hook, real-time UI |

## Socket Events

### Server-side
```javascript
io.on('connection', (socket) => {
  socket.on('join-pod', (podId) => {
    socket.join(`pod-${podId}`);
  });

  socket.on('message', async (data) => {
    const message = await MessageService.create(data);
    io.to(`pod-${data.podId}`).emit('message', message);
  });

  socket.on('typing', ({ podId, username }) => {
    socket.to(`pod-${podId}`).emit('typing', { username });
  });
});
```

### Client-side
```javascript
// Connect
const socket = io(SOCKET_URL, { auth: { token } });

// Join room
socket.emit('join-pod', podId);

// Send message
socket.emit('message', { podId, content });

// Listen for messages
socket.on('message', (msg) => {
  setMessages(prev => [...prev, msg]);
});
```

## Architecture

```
Client A ──► Socket.io Server ──► Client B
    │              │                  │
    │              ▼                  │
    │         Room: pod-123          │
    │              │                  │
    └──────────────┴──────────────────┘
                   │
                   ▼
              PostgreSQL
           (message persistence)
```

## Key Patterns

### Room-based Broadcasting
```javascript
// To everyone in room except sender
socket.to('pod-123').emit('event', data);

// To everyone in room including sender
io.to('pod-123').emit('event', data);
```

### Connection State
```javascript
socket.on('connect', () => console.log('Connected'));
socket.on('disconnect', () => console.log('Disconnected'));
socket.on('connect_error', (err) => console.log('Error:', err));
```

## Current Repo Notes (2026-02-04)

Skill catalog is generated from `external/awesome-openclaw-skills` into `docs/skills/awesome-agent-skills-index.json`.
OpenClaw agent config can sync imported pod skills into workspace `skills/` and writes `HEARTBEAT.md` per agent workspace.
