# Discord surface

This local adapter keeps Discord transport custody in SQLite and sends accepted messages to an already-owned native Codex task or an explicitly channel-enabled Claude session. It does not start a model executor, resume a history file, change native approval settings, or switch providers.

The runtime needs Node 22.5 or newer for `node:sqlite`. It resolves `discord.js` and the MCP SDK from `/Users/cphamballer/.codex/mcp/discord/node_modules`; no package installation or bot-token export is required.

Use a private state directory and an owner-only secret file. The secret file must contain only the Discord bot token and have mode `0600`.

```sh
mkdir -m 700 -p "$HOME/.config/discord-surface"
chmod 600 /path/to/discord-token
node src/cli.js configure \
  --state-dir "$HOME/.config/discord-surface" \
  --guild-id DISCORD_GUILD_ID \
  --operator-id DISCORD_USER_ID \
  --secret-file /path/to/discord-token
```

Bind each Discord channel to one exact native session UUID and absolute workspace. A Claude binding also names the Unix socket served by its opted-in MCP channel.

```sh
node src/cli.js bind --state-dir "$HOME/.config/discord-surface" \
  --channel-id CODEX_CHANNEL_ID --guild-id DISCORD_GUILD_ID \
  --provider codex --native-id CODEX_SESSION_UUID --workspace /absolute/workspace

node src/cli.js bind --state-dir "$HOME/.config/discord-surface" \
  --channel-id CLAUDE_CHANNEL_ID --guild-id DISCORD_GUILD_ID \
  --provider claude --native-id CLAUDE_SESSION_UUID \
  --workspace /absolute/workspace --endpoint /tmp/discord-surface-claude-501/probe.sock
```

For the `/conduct` integration, `provision` can idempotently create or find one text channel under the given vendor category. It stores an exact provider and native UUID marker in the channel topic, then binds the resulting channel. It never creates a native executor or resumes a session. The category ID is explicit so the command cannot choose a presentation category by name.

```sh
node src/cli.js provision --state-dir "$HOME/.config/discord-surface" \
  --category-id CODEX_CATEGORY_ID --provider codex \
  --native-id CODEX_SESSION_UUID --workspace /absolute/workspace
```

Run it once per vendor session. A later invocation with the same provider and UUID returns the existing binding without creating another channel. Discord permissions still need to allow channel creation under the selected category.

The bind and rebind commands reject a malformed UUID. Rebind and unbind wait until all accepted, dispatching, submitted, uncertain, and reply custody states have been reconciled. Each binding generation is persisted and stale native replies are rejected.

Start and stop the one Gateway consumer with the local macOS `lockf` singleton.

```sh
node src/cli.js start --state-dir "$HOME/.config/discord-surface"
node src/cli.js status --state-dir "$HOME/.config/discord-surface"
node src/cli.js stop --state-dir "$HOME/.config/discord-surface"
```

The Codex provider queues `codex queue --thread <UUID>` in the bound workspace. It observes only the matching session JSONL file and does not select a task by name, newest activity, directory, or process ID. The runtime never adds approval bypass flags.

Claude Channels require opt-in when the native Claude session launches. Start the channel server with the exact pre-bound UUID and short owner-only socket path, then pass that command in the MCP configuration used to launch the native session. The Claude process must be started with its Channels flag and the normal permission mode chosen by the operator.

```json
{
  "mcpServers": {
    "discord-surface": {
      "command": "node",
      "args": [
        "/absolute/path/to/discord-surface/src/cli.js",
        "claude-channel",
        "--state-dir",
        "/Users/you/.config/discord-surface",
        "--native-id",
        "CLAUDE_SESSION_UUID",
        "--socket",
        "/tmp/discord-surface-claude-501/probe.sock"
      ]
    }
  }
}
```

The channel process forwards events only after checking its exact native UUID, binding endpoint, and generation. Its `reply` tool requires the inbound Discord message ID and generation. It persists reply custody before acknowledging the MCP tool call. A Claude session without launch-time channel opt-in is not attached or resumed by this adapter.

Accepted input is durable before a Discord handler returns. If the native owner is unavailable before submission, the message stays `accepted` with a `dispatch-not-submitted` receipt and no execution-success reply. A process stop during dispatch changes `dispatching` to `uncertain`; it is never retried automatically. A failed or ambiguous Discord send retains the native reply and records `reply_failed` or `reply_unknown` for explicit reconciliation.

Run the simulated consumer and persistence scenarios with:

```sh
npm test
```

The tests use injected native providers and fake Discord events. They do not contact Discord, start Codex or Claude, or prove a live round trip. Live two-provider delivery, native channel opt-in, permissions, approvals, billing, and Discord category setup remain operator-owned gates.
