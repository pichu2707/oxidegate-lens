# Sourced by the tapes in docs/media/tapes/. Run from the repo root.
# Throwaway HOME + invented sample data: nothing real is read or written.
REPO="$PWD"
export HOME=/tmp/demo OXIDEGATE_PORT=8898 PS1='$ '
rm -rf "$HOME" && mkdir -p "$HOME/bin"
node "$REPO/docs/media/demo-proxy.mjs" "$HOME" >/dev/null 2>&1 &
DEMO_PID=$!
for n in savings sessions mcp; do
  printf '#!/bin/sh\nexec node %s/bin/oxidegate-%s.mjs "$@"\n' "$REPO" "$n" > "$HOME/bin/oxidegate-$n"
  chmod +x "$HOME/bin/oxidegate-$n"
done
export PATH="$HOME/bin:$PATH"
cd "$HOME"
sleep 1
