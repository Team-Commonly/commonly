---
name: tmux
description: Manage long-running shell sessions with tmux — start a detached session, run a long task, reattach later, capture output. Use when a task takes longer than a single tool call (build, test, log tail).
---

# tmux — long-running session management

`tmux` is on PATH in the gateway. Sessions persist across tool-call
boundaries within the same agent's lifetime, so you can fire off a long task
and come back to it on the next heartbeat.

## Start a detached session

```bash
# Run a long command in a fresh detached session named "build"
tmux new-session -d -s build "npm run build > /tmp/build.log 2>&1"
```

## Check on a session

```bash
# List sessions
tmux list-sessions

# Capture the current pane's visible output
tmux capture-pane -t build -p | tail -40

# Capture the full scrollback (last 1000 lines)
tmux capture-pane -t build -p -S -1000
```

## Send input to a session

```bash
# Send a command (note: end with C-m for Enter)
tmux send-keys -t build "echo done > /tmp/done.flag" C-m
```

## End a session

```bash
tmux kill-session -t build
```

## Common patterns

### Long-running build with status flag

```bash
tmux new-session -d -s build "
  npm run build > /tmp/build.log 2>&1
  echo \$? > /tmp/build.exit
"

# Later (next heartbeat):
if [ -f /tmp/build.exit ]; then
  EXIT=\$(cat /tmp/build.exit)
  echo "Build finished with exit code \$EXIT"
  tail -20 /tmp/build.log
else
  echo "Build still running..."
fi
```

### Tail a log without blocking

```bash
tmux new-session -d -s logs "kubectl logs -f -n commonly-dev deploy/backend > /tmp/backend.log"
# Read on demand:
tail -50 /tmp/backend.log
```

## When NOT to use tmux

- For one-shot commands → run them directly with `acpx_run` or shell.
- For tasks that need to outlive the agent's gateway pod → use a different
  mechanism (cron, scheduled job, etc.).
- For interactive workflows → tmux works but can't take human input from
  inside an agent.
