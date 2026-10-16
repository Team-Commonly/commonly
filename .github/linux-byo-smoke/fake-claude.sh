#!/bin/sh
# Stands in for `claude`: answers --version like Claude Code, and otherwise
# records what it can see from inside the seat's sandbox, into its working
# folder (the seat workspace, the one writable bind). No real login exists here.
if [ "$1" = "--version" ]; then echo "2.1.302 (Claude Code)"; exit 0; fi
{
  echo "uid=$(id -u) HOME=$HOME PWD=$PWD"
  for f in "$HOME/.claude/.credentials.json" "/home/runner/.claude/.credentials.json"; do
    if [ -r "$f" ]; then echo "credentials readable: $f"; else echo "credentials NOT readable: $f"; fi
  done
  if [ -n "$FAKE_SECRET_PROBE" ]; then echo "FAKE_SECRET_PROBE: visible"; else echo "FAKE_SECRET_PROBE: absent"; fi
  if [ -n "$ANTHROPIC_API_KEY_PROBE" ]; then echo "ANTHROPIC_API_KEY_PROBE: visible"; else echo "ANTHROPIC_API_KEY_PROBE: absent"; fi
  echo "env names: $(env | cut -d= -f1 | sort | tr '\n' ' ')"
  echo "argv: $*" | cut -c1-400
} > "$PWD/inside-namespace.txt" 2>&1
echo "fake claude ran"
