#!/bin/sh

script_dir=${0%/*}
if [ "$script_dir" = "$0" ]; then
  script_dir=.
fi
script_dir=$(CDPATH= cd -- "$script_dir" 2>/dev/null && pwd -P)
if [ -z "$script_dir" ]; then
  printf '%s\n' 'discord-surface courier guard: wrapper directory is unavailable' >&2
  exit 2
fi
cli="$script_dir/cli.js"

if [ ! -f "$cli" ]; then
  printf '%s\n' "discord-surface courier guard: CLI entrypoint is missing: $cli" >&2
  exit 2
fi

node_bin=${DISCORD_SURFACE_NODE:-}
if [ -n "$node_bin" ]; then
  case "$node_bin" in
    /*) ;;
    *)
      printf '%s\n' "discord-surface courier guard: configured node runtime must be an absolute path: $node_bin" >&2
      exit 2
      ;;
  esac
  if [ ! -x "$node_bin" ]; then
    printf '%s\n' "discord-surface courier guard: configured node runtime is not executable: $node_bin" >&2
    exit 2
  fi
else
  for candidate in /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node; do
    if [ -x "$candidate" ]; then
      node_bin=$candidate
      break
    fi
  done
  if [ -z "$node_bin" ]; then
    printf '%s\n' 'discord-surface courier guard: node runtime is unavailable' >&2
    exit 2
  fi
fi

if [ "${1-}" = '--disable-warning=ExperimentalWarning' ]; then
  shift
fi

"$node_bin" --disable-warning=ExperimentalWarning "$cli" courier-guard "$@"
status=$?
if [ "$status" -eq 0 ] || [ "$status" -eq 2 ]; then
  exit "$status"
fi

printf '%s\n' "discord-surface courier guard: launcher failed with exit $status" >&2
exit 2
