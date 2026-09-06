# TM board adapter requests

Received directly from the TM conductor after the operator requested a fuller Discord readout. Rendering remains script-side in `discord-board.py`, using the lane registry, verdict logs and lane beacons. TM reports `/cs full` is already live with a padded multipart text workaround. This record authorizes no runtime restart or deployment.

Priority 1: split reply text at the last newline before `REPLY_LIMIT`, preserving content and retaining a hard-limit fallback for a single long line. Existing owner: `state.js` `splitReply`. TM currently pads every nonfinal part to exactly 2,000 characters to force block boundaries. Remove the need for that workaround once adapter behavior is proved and the producer is coordinated.

Priority 3: update a pinned board message in place, using an explicit target message ID, rather than creating another board for each refresh. Prove target ownership and preserve delivery/custody semantics before connecting it to an automatic sidecar. Pinning itself and deleting prior messages are not implied by an edit request.

Remaining requested capabilities:

- Priority 2: structured embeds for a card title, stage color and per-lane fields, potentially supplied as JSON beside the text reply.
- Priority 4: one Discord thread per PR for accumulated verdict and gate summaries.
- Priority 5: an operator's check reaction acknowledges an existing owed item and is recorded. This is different from the adapter's saved reaction and the native agent's recognition acknowledgment in the current sidecar feature.

These are distinct from automatic model interpretation. Deterministic board rendering does not require an inference call. Implementation sequence should honor TM's stated priority of 1 and 3 first and reuse the existing Gateway and reply ownership boundaries.
