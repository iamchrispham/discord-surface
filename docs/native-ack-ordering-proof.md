# Native acknowledgment ordering

## Incident and scope

A native owner read an inbound /cs payload but delayed acknowledgment until after preparing its board. The adapter then sent eyes and the reply concurrently. The incident journal records successful eyes delivery 43 milliseconds before successful reply delivery, but the reply attempt started before eyes completed. This proves a race, not that the client displayed the reply first.

The native owner must run acknowledgment.command during its first payload-read operation, before doing the requested work. The adapter never infers native pickup from transport forwarding or from the existence of a reply.

## Fix

The acknowledgment owner supplies one per-message delivery function shared by the Gateway reply sender and the existing acknowledgment watcher. A reply joins its pending or in-flight eyes attempt before sending. This works during startup recovery before the watcher starts, and does not wait behind another channel's pending acknowledgment. Completed attempts are not repeated. With no actual native acknowledgment, the reply keeps its prior path.

An unsuccessful reaction retains its existing failed or unknown receipt and retry behavior. The reply can proceed after that attempt finishes. This preserves useful delivery when Discord reactions are unavailable. It does not promise eyes before replies on a failed reaction, or fabricate a successful eyes receipt. The existing auxiliary request timeout bounds the wait, and stop aborts the request. The reply rechecks stop and current ownership after waiting.

## Validation

- Real SQLite state and the actual reply consumer, with controlled HTTP reaction completion: a pending reaction blocks the reply network call, then releasing it permits delivery.
- Watcher and reply sender join the same attempt without duplicate HTTP requests.
- Recovery before watcher startup, permanent reaction failure, transient reaction failure, Gateway stop, another blocked channel, and absent native acknowledgment are exercised.
- Removing only the reply ordering call makes both ordering tests fail at their behavioral assertions. Restoring it passes. The existing login-time recovery test also passes.
- Node 22.23.2, repository npm test: 235 passing, zero failures, cancellations or skips. Registered files: surface.test.js, native-transcript.test.js, liaison-process.test.js, context-interpretation.test.js, publication.test.js, direct-post.test.js, publication-reference.test.js.

## Live pickup verification

The existing TM native owner adopted a first-operation pickup helper. On the authorized TM-ACK-ORDER-0907 probe, inbox completed at 12:09:46.306 am Pacific, genuine native acknowledgment at 12:09:50.164 am, eyes completed at 12:09:50.776 am, and reply delivery at 12:09:54.560 am. Its public native tool trace shows acknowledgment during the first payload-read operation. Discord desktop displayed both reactions and the correct reply, 803.

The live probe proves corrected native pickup timing on the unchanged installed pilot. It does not prove the new Gateway source is deployed. The shared Gateway and native Monitor retained their original processes. The original temporary screenshot had disappeared, so its historical appearance could not be inspected.

This narrow repair is based on the preserved pilot branch. It neither resumes the shelved model experiment nor deploys that branch's other uninstalled changes.
