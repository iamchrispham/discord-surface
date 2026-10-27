# Discord Surface

Use Discord to send instructions to an existing Codex or Claude Code session and receive its
replies.

Discord Surface runs locally. One Gateway receives Discord events, SQLite stores bindings and
message progress, and the native session does the work. A binding connects a channel to one
session UUID and generation. Installing or restarting the adapter does not create a replacement
session or change native approval settings.

## What it supports

| Use | How |
| --- | --- |
| Talk to an existing session | Bind a channel to that session and use its native delivery integration. |
| Keep ticket discussions separate | Enroll existing public threads under a bound parent channel. |
| Publish a milestone or file | Post from the bound session with a stable dedupe key. |
| Ask for a decision | Ask a question with buttons and retain its answer. |
| Exchange work between sessions | Send signed requests and correlated results through the CLI or peer MCP tools. |

The [runtime
reference](https://github.com/iamchrispham/discord-surface/blob/main/docs/runtime-reference.md)
covers these commands, their required identities, and recovery after interrupted operations.

## Install and configure

The package is private. Use the release commit or tarball supplied for your installation and
follow [INSTALL.md](INSTALL.md). That guide covers building, installing into a dedicated prefix,
configuring credentials, and checking the host.

You need Node **22.13.0 or later in the 22.x line**, Git, npm, a Discord bot, and an existing
authenticated native session. The runtime uses SQLite, Unix sockets, process inspection, and
BSD-style `lockf`. Linux and Windows runtime support require separate qualification. A passing
build or package import does not establish native delivery on another OS.

The bot must be able to view the intended channels, read their history, send messages, and add
receipt reactions. Enable its [Message Content
intent](https://docs.discord.com/developers/events/gateway#enabling-privileged-intents) in the
Developer Portal. The client requests `Guilds`, `GuildMessages`, and `MessageContent`.

Configuration needs the guild, operator, and provider-category IDs. Keep the state directory
private and the bot's `DISCORD_TOKEN` in an owner-only dotenv file. The [configuration
example](INSTALL.md#configure-on-a-compatible-host) shows the exact command.

Examples below use a built source checkout. For an installed package, replace `src/cli.js` with
that release's absolute installed CLI path. Use the same release and state directory for every
caller.

## Run the Gateway

Run the long-lived Gateway in its own terminal or through the installation's existing service:

```sh
node src/cli.js start --state-dir "$HOME/.config/discord-surface"
```

Inspect it from another terminal:

```sh
node src/cli.js status --state-dir "$HOME/.config/discord-surface"
```

Use `stop --state-dir <directory>` for a normal shutdown. Keep one Gateway consumer for the
installation. Coordinate a shared deployment before starting another host against the same
guild, since local locks do not coordinate hosts.

## Ordinary Codex session binding

Run this from the **existing Codex session's own command context**:

```sh
node src/cli.js ordinary-bind \
  --state-dir "$HOME/.config/discord-surface" \
  --channel-id EXISTING_CHANNEL_ID
```

The command verifies the caller against its transcript and binds an existing channel. A quoted
`--channel '#channel-name'` can select an unambiguous channel name. Do not copy another
session's identity into the environment.

Standard Codex intake uses `codex queue --thread` to offer a follow-up turn. Delivery during an
active turn needs a separately qualified courier route and a trusted native hook. Selecting a
route or installing its guard does not establish that delivery works. See [Gateway and courier
routes](https://github.com/iamchrispham/discord-surface/blob/main/docs/runtime-reference.md#gateway-and-courier-routes).

## Ordinary Claude session binding

Run this from the **existing Claude Code session's own command context**:

```sh
node src/cli.js ordinary-claude-bind \
  --state-dir "$HOME/.config/discord-surface" \
  --channel-id EXISTING_CHANNEL_ID \
  --endpoint SHORT_OWNER_ONLY_SOCKET_PATH \
  --transcript /absolute/path/to/the/current/session.jsonl
```

This requires the local caller-identity integration at
`~/.claude/hooks/session-chat-binding.mjs`, which the package does not install. The transcript
must belong to the caller. Choose a short absolute socket path in a private directory. It
verifies that identity and cannot select a different session.

After binding, use the returned native ID and endpoint to start `claude-monitor` through that
same session's native **Monitor** tool. A session already launched with Channels opt-in may use
`claude-channel` instead. Run one listener per socket.

[Claude attachment
details](https://github.com/iamchrispham/discord-surface/blob/main/docs/runtime-reference.md#ordinary-claude-session-binding)
include the Monitor command, acknowledgment handling, and listener recovery.

## Verify delivery

Send one real instruction to the bound channel. Confirm that it reaches the intended native
session, receives its acknowledgment, and produces a reply in Discord correlated with the source
message. Then verify one explicit milestone post from that session. The [installation
checklist](INSTALL.md#essential-live-check-and-return-receipt) records the evidence to keep.

These observations mean different things:

| Observation | What it establishes |
| --- | --- |
| `status.gateway.state: running` | The recorded process identity matches. Discord connectivity is still unverified. |
| A receipt reaction or saved-message receipt | The input was saved. |
| A native acknowledgment | The native owner recorded pickup. |
| A correlated reply visible in Discord | The reply reached Discord for that source message. |
| A saved button answer | The question handler recorded the answer. Native return still needs verification. |

If a route is pending, unavailable, or has a history gap, retain its session and saved messages.
Inspect the reported boundary before using a scoped recovery command. Uncertain submissions or
sends must not be replayed on the strength of a timeout. See [delivery and
recovery](https://github.com/iamchrispham/discord-surface/blob/main/docs/runtime-reference.md#delivery-and-recovery).

## Authenticated peer MCP

The `mcp` command exposes `peer_list`, `peer_send`, `peer_result`, and `post` over stdio.
Register it through a native integration that supplies the current caller identity and loads the
tools into that same session. Saving server configuration alone does not do either.

A new peer request needs a ready caller and recipient, each with one ready enrolled child.
Results follow the request's recorded return route. A sent packet does not establish native
pickup or completion.

See [peer MCP setup and tool
arguments](https://github.com/iamchrispham/discord-surface/blob/main/docs/runtime-reference.md#authenticated-peer-mcp).

## Development

From a clean checkout:

```sh
npm ci
npm run build
npm run typecheck
```

Use the repository's supervised entries for the full suite and package check:

```sh
python3 -I scripts/full-gate/supervisor.py -- npm test
python3 -I scripts/full-gate/supervisor.py -- npm run package-smoke
```

Unset `NODE_OPTIONS` and configure the host's admission command and time allowances as described
in [INSTALL.md](INSTALL.md#build-and-inspect-the-package). The test entry builds, typechecks,
and runs the explicitly registered files serially. New suites must be added to `scripts.test` in
`package.json`.

Exit 98 with `APERTURE-GATE-INDETERMINATE` means no verdict. It is neither a pass nor a test
failure. Follow the reported reason before rescheduling. Packaging checks use an isolated
installation and do not start the Gateway.

Documentation-only changes need command, path, link, and diff checks. Runtime tests use
disposable databases and simulated transport. Keep live credentials, native sessions, and the
shared Gateway out of test fixtures.

## Documentation

| Document | Read it for |
| --- | --- |
| [Installation](INSTALL.md) | Release selection, host requirements, credentials, attachment, and live checks. |
| [Runtime reference](https://github.com/iamchrispham/discord-surface/blob/main/docs/runtime-reference.md) | CLI examples, threads, handoff, files, decisions, peer tools, and recovery rules. |
| [Conductor post proof](https://github.com/iamchrispham/discord-surface/blob/main/docs/conductor-post-proof.md) | The recorded milestone-publication proof and its limits. |
| [Repository guidance](https://github.com/iamchrispham/discord-surface/blob/main/AGENTS.md) | Code ownership, validation, and contribution rules. |
