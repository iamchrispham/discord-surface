# Discord surface

This local adapter keeps Discord transport custody in SQLite and sends accepted messages to an already-owned native Codex task or an explicitly channel-enabled Claude session. It does not start a model executor, resume a history file, change native approval settings, or switch providers.

The runtime needs Node 22.5 or newer for `node:sqlite`. It resolves `discord.js` and the MCP SDK from `/Users/cphamballer/.codex/mcp/discord/node_modules`; no package installation or bot-token export is required.

Use a private state directory and an owner-only dotenv file. The secret file must contain a `DISCORD_TOKEN=` assignment and have mode `0600`.

```sh
mkdir -m 700 -p "$HOME/.config/discord-surface"
chmod 600 /path/to/discord.env
node src/cli.js configure \
  --state-dir "$HOME/.config/discord-surface" \
  --guild-id DISCORD_GUILD_ID \
  --operator-id DISCORD_USER_ID \
  --secret-file /path/to/discord.env \
  --codex-category-id CODEX_CATEGORY_ID \
  --claude-category-id CLAUDE_CATEGORY_ID
```

The adapter reads `DISCORD_TOKEN=...` without exporting or logging the value.

Bind each Discord channel to one exact conductor identity and its current native session UUID. The conductor ID comes from the existing conductor claim and is never derived from a session UUID, PID, account, or display name. Repository metadata is canonical identity supplied by that claim. A Claude binding also names the Unix socket served by its opted-in MCP channel.

```sh
node src/cli.js bind --state-dir "$HOME/.config/discord-surface" \
  --channel-id CODEX_CHANNEL_ID --guild-id DISCORD_GUILD_ID \
  --provider codex --native-id CODEX_SESSION_UUID --workspace /absolute/workspace \
  --conductor-id CONDUCTOR_ID --repo-key CANONICAL_REPOSITORY_KEY

node src/cli.js bind --state-dir "$HOME/.config/discord-surface" \
  --channel-id CLAUDE_CHANNEL_ID --guild-id DISCORD_GUILD_ID \
  --provider claude --native-id CLAUDE_SESSION_UUID \
  --workspace /absolute/workspace --endpoint /tmp/discord-surface-claude-501/probe.sock \
  --conductor-id CONDUCTOR_ID --repo-key CANONICAL_REPOSITORY_KEY
```

For the `/conduct` integration, `provision` creates or reuses one text channel for the stable conductor under its configured vendor category. Its topic is a fixed address marker. Local SQLite stores the provider, canonical repository key, native UUID, generation, readiness, history coverage, and custody. It never creates a native executor or resumes a session. The category comes from configuration, so a Codex command cannot choose the Claude category.

```sh
node src/cli.js provision --state-dir "$HOME/.config/discord-surface" \
  --provider codex --conductor-id CONDUCTOR_ID \
  --repo-key CANONICAL_REPOSITORY_KEY --task-name optional-presentation-name \
  --native-id CODEX_SESSION_UUID --workspace /absolute/workspace
```

Repeated setup with the same conductor ID verifies the existing category, fixed marker, binding, URL, and generation before returning the same channel. It does not rewrite the topic. An existing setup channel can be adopted explicitly after category and legacy native metadata validation:

```sh
node src/cli.js provision --state-dir "$HOME/.config/discord-surface" \
  --provider codex --conductor-id CONDUCTOR_ID \
  --repo-key CANONICAL_REPOSITORY_KEY --native-id CODEX_SESSION_UUID \
  --workspace /absolute/workspace --channel-id EXISTING_CHANNEL_ID
```

A successor native session keeps the same channel only through an explicit drained or reconciled handoff. Account rotation does not change the binding. The handoff requires a caller-supplied handoff ID from the existing authority mechanism, records it, and increases the generation:

```sh
node src/cli.js handoff --state-dir "$HOME/.config/discord-surface" \
  --provider codex --conductor-id CONDUCTOR_ID \
  --repo-key CANONICAL_REPOSITORY_KEY --channel-id CHANNEL_ID \
  --from-native-id OLD_SESSION_UUID --from-generation 1 \
  --native-id NEW_SESSION_UUID --workspace /absolute/workspace \
  --handoff-id AUTHORITY_HANDOFF_ID
```

Handoff changes the local native binding and generation after explicit authority and drained or reconciled custody. It does not edit the topic. Legacy topic publication custody, when present, must be explicitly reconciled before migration or handoff. A late legacy publication settles only its own audit record and cannot change local readiness or history coverage.

An interrupted channel create leaves a durable intent. A later invocation may reconcile an exact topic marker or use explicit `--channel-id` adoption. If the create outcome is unknown and no channel evidence exists, the adapter stops rather than creating a possible duplicate. Discord permissions still need to allow channel creation under the selected category. `--task-name` changes presentation only. Ordinary workers and forks have no provisioning path.

The bind and rebind commands reject a malformed UUID. Rebind and unbind wait until all accepted, dispatching, submitted, uncertain, and reply custody states have been reconciled. Unbind leaves an inactive tombstone so replied history remains readable. Each binding generation is persisted and stale native replies are rejected. Provider identity is checked with the UUID at every native reply boundary, so the same UUID under another provider cannot populate custody.

Start and stop the one Gateway consumer with the local macOS `lockf` singleton.

```sh
node src/cli.js start --state-dir "$HOME/.config/discord-surface"
node src/cli.js status --state-dir "$HOME/.config/discord-surface"
node src/cli.js stop --state-dir "$HOME/.config/discord-surface"
```

The Codex provider queues `codex queue --thread <UUID>` in the bound workspace. It observes only the matching session JSONL file and does not select a task by name, newest activity, directory, or process ID. The runtime never adds approval bypass flags.

Claude Channels require opt-in when the native Claude session launches. Start the channel server with the exact pre-bound UUID and short owner-only socket path, then pass that command in the MCP configuration used to launch the native session. The Claude process must be started with its Channels flag and the normal permission mode chosen by the operator. EOF or transport close stops the HTTP server, socket, MCP transport, and local state handle.

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

Accepted input is durable before a Discord handler returns. After authorized intake commits, live input gets one deterministic transport receipt. The receipt says either `Receipt: saved for this conductor.` or `Receipt: saved. Delivery was paused when this receipt was prepared.` It is a reply to the source message with mentions disabled. It never claims that the native agent has read, acted on, or answered the input. Receipt delivery is independent of native forwarding, uses a stable nonce, and never retries an uncertain send. Duplicate or rejected input gets no receipt attempt.

During login and reconnect, messages are durably held while a persisted Discord watermark is backfilled. Adoption starts at the newest observed message, so pre-adoption history is not executed. Backfill is bounded at 100 messages per page, 10 pages, 1,000 messages, or 30 seconds. A fetch, processing, or bound failure records a visible gap and readiness stays unavailable until explicit reconciliation. The native output cursor is separate from this inbound Discord watermark.

An empty Discord history response is accepted as coverage only when the bot's effective channel permissions include View Channel and Read Message History. A denied or unknown permission state remains visibly unavailable. `status` exposes both the observed message ID and the confirmed recovered-through ID.

The topic is exactly `discord-surface:v3 conductor=<encoded-conductor-id> provider=<vendor> repo=<encoded-repo-key> [address only, not live status]`. It never carries native UUID, generation, readiness, connectivity, or timestamps. Recovery, reconnect, handoff, account rotation, and message handling perform no topic PATCH. Local status is authoritative for native availability and history coverage. `status` also exposes receipt attempts and outcomes. Legacy v1/v2 topics remain read-only evidence for explicit channel adoption or migration. Unresolved legacy publication custody blocks that migration until the existing evidence-based reconciliation is complete. The `recover --topic-channel-id` path is legacy-only and never changes local execution readiness.

If the native owner is unavailable before submission, the message stays `accepted` with a `dispatch-not-submitted` receipt and no execution-success reply. A process stop during dispatch changes `dispatching` to `uncertain`; it is never retried automatically. A failed or ambiguous Discord send retains the native reply and records `reply_failed` or `reply_unknown` for explicit delivery reconciliation. Replies longer than Discord's 2000-character message limit are durably split into ordered parts, each with a stable nonce and nonce enforcement. The adapter never silently truncates a native reply.

After a restart, the runtime makes one bounded transport recovery pass. It may drain definitely accepted work, resume observation from the saved byte cursor for submitted work, and deliver saved reply parts. Work that was uncertain at the dispatch boundary is never replayed automatically. Reconcile it explicitly after evidence is available:

```sh
node src/cli.js recover --state-dir "$HOME/.config/discord-surface" \
  --message-id DISCORD_MESSAGE_ID --resolution submitted
```

`status` reports pending custody and labels live permission, native approval, quota, billing, and connection gates. Simulated tests do not prove those live gates. Completion evidence and live trials remain conductor-owned.

To clear a recorded Discord intake gap after inspecting the attempted range, request explicit reconciliation and restart the Gateway:

```sh
node src/cli.js recover --state-dir "$HOME/.config/discord-surface" \
  --intake-channel-id CHANNEL_ID
```

Delivery-only reconciliation never calls a native provider. Use `--resolution reply_not_sent` after evidence that no Discord message was created, or `--resolution reply_sent --part-index N --reply-message-id MESSAGE_ID` after finding the message. The adapter does not infer either outcome from a timeout.

Cswap owns Claude account rotation. The adapter keeps provider plus native UUID and generation as the binding identity, so credential rotation does not recreate a session, reset a generation, discard custody, or replay work. The adapter has no provider account identity API and cannot prove which rotated account is active.

Run the simulated consumer and persistence scenarios with:

```sh
npm test
```

The tests use injected native providers and fake Discord events. They do not contact Discord, start Codex or Claude, or prove a live round trip. Live two-provider delivery, native channel opt-in, permissions, approvals, billing, quota, and Discord category setup remain conductor-owned gates until directly verified.
