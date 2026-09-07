# Discord surface

This local adapter keeps Discord transport custody in SQLite and sends accepted messages to an already-owned native Codex task or an explicitly channel-enabled Claude session. It does not start a model executor, resume a history file, change native approval settings, or switch providers.

The runtime needs Node 22.5 or newer for `node:sqlite`. Run `npm ci` from a clean checkout to install the pinned runtime dependencies locally, then run `npm run build` before starting. The package resolves `discord.js` and the MCP SDK from its local `node_modules`. The running adapter uses emitted JavaScript and does not need the compiler installed.

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

Repeated setup with the same conductor ID verifies the existing category, fixed marker, binding, URL, and generation before returning the same channel. It does not rewrite the topic. A fresh invocation that sees a remote marker must carry `--channel-id` before it can adopt that channel. An existing setup channel can be adopted explicitly after category and legacy native metadata validation:

```sh
node src/cli.js provision --state-dir "$HOME/.config/discord-surface" \
  --provider codex --conductor-id CONDUCTOR_ID \
  --repo-key CANONICAL_REPOSITORY_KEY --native-id CODEX_SESSION_UUID \
  --workspace /absolute/workspace --channel-id EXISTING_CHANNEL_ID
```

Legacy v1 or v2 topics are read-only evidence. Ordinary setup and handoff reject them. A one-time migration requires the explicit channel ID and flag below. It validates the local conductor, repository, provider, native UUID, generation, guild, and category before one bounded topic update:

```sh
node src/cli.js provision --state-dir "$HOME/.config/discord-surface" \
  --provider codex --conductor-id CONDUCTOR_ID \
  --repo-key CANONICAL_REPOSITORY_KEY --native-id CODEX_SESSION_UUID \
  --workspace /absolute/workspace --channel-id EXISTING_CHANNEL_ID \
  --migrate-legacy-topic
```

A definite Discord response records migration success or rejection. A lost response stays unresolved and blocks migration, rebind, handoff, and readiness until the existing evidence-based reconciliation command proves its outcome. Migration never recreates a channel, retries a request, or restores execution readiness by itself.

A successor native session keeps the same channel only through an explicit drained or reconciled handoff. Account rotation does not change the binding. The manual handoff path below retains caller-supplied channel, predecessor UUID, generation, and handoff ID values:

```sh
node src/cli.js handoff --state-dir "$HOME/.config/discord-surface" \
  --provider codex --conductor-id CONDUCTOR_ID \
  --repo-key CANONICAL_REPOSITORY_KEY --channel-id CHANNEL_ID \
  --from-native-id OLD_SESSION_UUID --from-generation 1 \
  --native-id NEW_SESSION_UUID --workspace /absolute/workspace \
  --handoff-id AUTHORITY_HANDOFF_ID
```

Canonical conductor pickup can derive those values from the active binding and lock history. Supply the authoritative remote, vendor, stable conductor ID, exact successor UUID, workspace, transcript, and worker manifest:

```sh
node src/cli.js handoff --state-dir "$HOME/.config/discord-surface" \
  --from-lock --repo FULL_AUTHORITATIVE_REMOTE --provider VENDOR \
  --conductor-id STABLE_ID --repo-key CANONICAL_KEY \
  --native-id SUCCESSOR_UUID --workspace FULL_WORKSPACE \
  --session-file EXACT_TRANSCRIPT --worker-file EXACT_MANIFEST
```

For Claude, also pass `--endpoint FULL_ENDPOINT`. Normal pickup requires the canonical lock to show the predecessor release followed by the successor claim, with no intervening owner-changing verb. Forced takeover or missing history fails closed. The exact transcript and worker manifest must identify the full successor UUID and live process generation. Unresolved intake or publication custody still blocks the handoff and remains unchanged on refusal.

Handoff changes the local native binding and generation after explicit authority and drained or reconciled custody. It does not edit the topic. Legacy topic publication custody, when present, must be explicitly reconciled before migration or handoff. A late legacy publication settles only its own audit record and cannot change local readiness or history coverage.

An interrupted channel create leaves a durable intent. A later invocation may reconcile an exact topic marker or use explicit `--channel-id` adoption. If the create outcome is unknown and no channel evidence exists, the adapter stops rather than creating a possible duplicate. Discord permissions still need to allow channel creation under the selected category. `--task-name` changes presentation only. Ordinary workers and forks have no provisioning path.

The bind and rebind commands reject a malformed UUID. Rebind and unbind wait until all accepted, dispatching, submitted, uncertain, and reply custody states have been reconciled. Unbind leaves an inactive tombstone so replied history remains readable. Each binding generation is persisted and stale native replies are rejected. Provider identity is checked with the UUID at every native reply boundary, so the same UUID under another provider cannot populate custody.

Start and stop the one Gateway consumer with the local macOS `lockf` singleton.

```sh
node src/cli.js start --state-dir "$HOME/.config/discord-surface"
node src/cli.js status --state-dir "$HOME/.config/discord-surface"
node src/cli.js stop --state-dir "$HOME/.config/discord-surface"
```

`status` includes a `gateway` process object. Its `state` is `running` only when the runtime PID file and the matching `ps` command identify this adapter and state directory. `stopped` means no PID file exists, `stale` means the recorded process is gone, and `unknown` means the PID file or owner identity cannot be verified. A `running` process reports `connection: unverified-live`; it does not claim a Discord connection.

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

A running Claude session may opt into the same transport through its native `Monitor` tool without a session restart. Start this blocking command from `Monitor` with the exact bound UUID and socket. The command writes no startup text. Each accepted event becomes one compact JSON line on stdout with the exact IDs and an owner-only `payloadPath`. Use `Read` on that path for the complete event, then follow its reply instructions. The payload is retained for recovery. The final answer goes to its suggested reply file and the command calls the same durable `recordNativeReply` path as the Claude channel tool.

```text
Monitor command:
node /absolute/path/to/discord-surface/src/cli.js claude-monitor \
  --state-dir /Users/you/.config/discord-surface \
  --native-id CLAUDE_SESSION_UUID \
  --socket /tmp/discord-surface-claude-501/probe.sock
```

The Monitor process owns its listener lifetime. It ignores stdin EOF, stops on native cancellation or signal, and removes only its own socket. Reply files belong to the native owner and are never blanket-cleaned by the adapter. A second listener on the same socket is rejected. Monitor startup does not promote native execution readiness. Discord intake readiness and native execution status remain separate. A stopped or abruptly lost Monitor never causes submitted work to be sent again.

Accepted input is durable before a Discord handler returns. After authorized intake commits, live input gets one deterministic transport receipt. The receipt says either `Receipt: saved for this conductor.` or `Receipt: saved. Delivery was paused when this receipt was prepared.` It is a reply to the source message with mentions disabled. It never claims that the native agent has read, acted on, or answered the input. Receipt delivery is independent of native forwarding, uses a stable nonce, and never retries an uncertain send. Duplicate or rejected input gets no receipt attempt.

Discord attachments are retained as validated URL metadata with the message, including filename, MIME type, and size. The adapter never downloads or archives attachment bytes. CDN URLs can expire, so native sessions receive the references as untrusted user data and decide whether they need to read them.

An operator may request one manual Spark preview from an existing durable receipt. The command reads one persisted source message and its transport receipt, keeps that raw evidence beside the result, and sends only code-derived facts to the isolated read-only Spark subprocess. The result is labeled `liaison draft`; it is never posted to Discord and never changes forwarding or custody. Missing receipts, unavailable Spark, invalid output, quota failure, timeout, and cancellation return `draft: null`.

```sh
node src/cli.js liaison draft \
  --state-dir "$HOME/.config/discord-surface" \
  --receipt-id DURABLE_RECEIPT_ID
```

`--receipt-id` accepts the source Discord message ID or the numeric SQLite receipt row ID. Both forms must resolve to one persisted transport receipt.

During login and reconnect, messages are durably held while a persisted Discord watermark is backfilled. Adoption starts at the newest observed message, so pre-adoption history is not executed. Backfill is bounded at 100 messages per page, 10 pages, 1,000 messages, or 30 seconds. A fetch, processing, or bound failure records a visible gap and readiness stays unavailable until explicit reconciliation. The native output cursor is separate from this inbound Discord watermark.

An empty Discord history response is accepted as coverage only when the bot's effective channel permissions include View Channel and Read Message History. A denied or unknown permission state remains visibly unavailable. `status` exposes both the observed message ID and the confirmed recovered-through ID.

The topic is exactly `discord-surface:v3 conductor=<encoded-conductor-id> provider=<vendor> repo=<encoded-repo-key> [address only, not live status]`. It never carries native UUID, generation, readiness, connectivity, or timestamps. Recovery, reconnect, handoff, account rotation, and message handling perform no topic PATCH. Local status is authoritative for native availability and history coverage. `status` also exposes receipt attempts and outcomes. Legacy v1/v2 topics remain read-only evidence for explicit channel adoption or migration. Unresolved legacy publication custody blocks that migration until the existing evidence-based reconciliation is complete. The `recover --topic-channel-id` path is legacy-only and never changes local execution readiness.

If the native owner is unavailable before submission, the message stays `accepted` with a `dispatch-not-submitted` receipt and no execution-success reply. A process stop during dispatch changes `dispatching` to `uncertain`; it is never retried automatically. A failed or ambiguous Discord send retains the native reply and records `reply_failed` or `reply_unknown` for explicit delivery reconciliation. Replies longer than Discord's 2000-character message limit are durably split into ordered parts, each with a stable nonce and nonce enforcement. The adapter never silently truncates a native reply.

After a restart, the runtime makes one bounded transport recovery pass. It may drain definitely accepted work, resume observation from the saved byte cursor for submitted work, and deliver saved reply parts. Work that was uncertain at the dispatch boundary is never replayed automatically. Reconcile it explicitly after evidence is available:

While the Gateway is running, each live submitted message keeps its one native observer beyond that bounded recovery window until a final response, explicit cancellation, shutdown, or binding fence. Reconnect recovery reuses that observer and does not start a second one.

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

The tests use injected native providers and fake Discord events. They do not contact Discord, start Codex, Claude, or Spark, or prove a live round trip. Live two-provider delivery, native channel opt-in, permissions, approvals, billing, quota, and Discord category setup remain conductor-owned gates until directly verified.

## Conductor milestone announcements

`post` sends an explicit milestone from an existing bound conductor without an inbound message, a running Gateway, or sidecar inference. `claude-post` is the Claude-only alias. Use it for a landing, a blocker, or a ruling the operator may want to override. Keep round-by-round detail in beacons and PR bodies. Human-grade events retain the existing phone path. This command sends no Telegram copy.

```sh
node src/cli.js claude-post \
  --state-dir "$HOME/.config/discord-surface" \
  --db "$HOME/.config/discord-surface/surface.sqlite" \
  --native-id FULL_NATIVE_UUID --generation CURRENT_GENERATION \
  --text-file /absolute/path/to/milestone.txt \
  --dedupe-key MILESTONE_KEY
```

The native ID must resolve to exactly one active conductor binding. Use `--channel-id` if it is ambiguous. The command refuses a stale generation and checks authority again before every split part. The same `splitReply` implementation and 10,000-character text limit apply to native replies and announcements. Mentions are suppressed.

The CLI requires `--dedupe-key`. Existing callers may use `--request-id` as a legacy alias. If both are supplied they must match. Direct JavaScript callers may omit both and retain the derived fallback identity. Add `--in-reply-to DISCORD_MESSAGE_ID` to attach each part to an existing message in the bound channel. Discord validates that reference with `fail_if_not_exists`; the reference can predate the current conductor generation or be bot-authored. A different target with the same explicit key is rejected by durable custody.

Repeat the same key, target and unchanged file to inspect or resume the same milestone, not create a duplicate. A new successful send returns `recorded: true, duplicate: false, state: "sent"`. A repeated confirmed send returns `recorded: false, duplicate: true, state: "sent"`. Partial, unknown, in-flight and stale results retain their existing `status`, `requestId`, `messageIds` and `parts` fields and expose the same value as `state`. Confirmed parts are skipped on retry. A request interrupted after its durable attempt stays uncertain and is never blindly resent. Definite unsent failures can be retried explicitly. Each part's attempt and delivery result are recorded in the existing receipts table.

No native session, channel binding, automatic publication selection or phone configuration is changed. A successful receipt means Discord accepted the returned message IDs, not that the operator read them.
