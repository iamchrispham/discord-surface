#!/usr/bin/env python3
"""Read existing conductor records without entering a native session."""
import argparse
import datetime
import hashlib
import json
import pathlib
import sys

MAX_BYTES = 2 * 1024 * 1024
STALE_SECONDS = 30 * 60


def text(value, limit=600):
    return value if isinstance(value, str) and 0 < len(value) <= limit else None


def epoch(value):
    if not isinstance(value, str):
        return None
    try:
        stamp = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
        return stamp.timestamp() if stamp.tzinfo else None
    except ValueError:
        return None


def field(record, key, kind):
    if key not in record:
        return {"state": "missing", "value": None}
    value = record[key]
    if kind == "text":
        valid = text(value) is not None
    elif kind == "steps":
        valid = isinstance(value, list) and len(value) <= 12 and all(text(v) for v in value)
    else:
        valid = isinstance(value, list) and len(value) <= 30
        if valid:
            valid = all(isinstance(v, dict) and text(v.get("id"), 128) and text(v.get("text"))
                        and epoch(v.get("since")) is not None for v in value)
        if valid:
            valid = len({v["id"] for v in value}) == len(value)
            value = [{k: v[k] for k in ("id", "text", "since")} for v in value]
    return {"state": "recorded" if valid else "invalid", "value": value if valid else None}


def snapshot(binding, registry, ladder_dir, now):
    sys.path.insert(0, str(ladder_dir))
    ladder_path = pathlib.Path(ladder_dir) / "lane_progress_ladder.py"
    ladder = {"__file__": str(ladder_path), "__name__": "lane_progress_ladder"}
    # Timestamp-based bytecode can miss equal-size edits within one second.
    exec(compile(ladder_path.read_bytes(), str(ladder_path), "exec"), ladder)
    PCT, canonical = ladder["PCT"], ladder["canonical"]

    source = pathlib.Path(registry)
    with source.open("rb") as stream:
        raw = stream.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError("registry exceeds snapshot read bound")
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("registry must be an object")
    owner = binding["conductorId"]
    records = data.get("_conductors", {})
    record = records.get(owner) if isinstance(records, dict) else None
    identity = {key: binding[key] for key in ("conductorId", "repoKey", "provider", "nativeId", "generation", "channelId")}
    status = "missing"
    if isinstance(record, dict):
        matches = (record.get("repository") == binding["repoKey"] and record.get("vendor") == binding["provider"]
                   and record.get("nativeId") == binding["nativeId"] and type(record.get("generation")) is int
                   and record["generation"] == binding["generation"])
        status = "recorded" if matches else "wrong-owner"
    if status != "recorded":
        record = {}
    updated = epoch(record.get("updated"))
    freshness = "unknown" if updated is None or updated > now else "stale" if now - updated >= STALE_SECONDS else "current"
    context = {
        "state": status, "updated": record.get("updated"), "freshness": freshness,
        "owedByOperator": field(record, "owed_by_operator", "owed"),
        "owedToOperator": field(record, "owed_to_operator", "owed"),
        "intent": field(record, "intent", "text"), "next": field(record, "next", "steps")
    }
    native_id = binding["nativeId"]
    owner_tokens = {owner, native_id, "session-" + binding["provider"] + "-" + native_id}
    lanes = []
    for key, lane in data.items():
        if key.startswith("_") or not isinstance(lane, dict) or lane.get("vendor") != binding["provider"]:
            continue
        repo = lane.get("repository", lane.get("repoKey"))
        lane_native_id = lane.get("nativeId", lane.get("native_id"))
        lane_generation = lane.get("generation")
        lane_identity_present = any(key in lane for key in ("nativeId", "native_id", "generation"))
        lane_proves_binding = (lane_native_id == native_id and type(lane_generation) is int
                               and lane_generation == binding["generation"])
        abbreviated_owner = (binding["provider"] == "claude" and
                             lane.get("conductor") == "session-claude-" + native_id[:8])
        if lane.get("conductor") not in owner_tokens and not (abbreviated_owner and lane_proves_binding):
            continue
        if lane_identity_present and not lane_proves_binding:
            continue
        if status != "recorded" and not lane_proves_binding:
            continue
        if repo is not None and repo != binding["repoKey"]:
            continue
        stage = canonical(lane.get("phase"))
        if stage == "done":
            continue
        held = stage in ("held", "parked", "frozen")
        percent = PCT.get(canonical(lane.get("phase_before_hold")) if held else stage)
        lanes.append({"id": key, "pr": lane.get("pr"), "ticket": text(lane.get("ticket"), 128),
                      "head": text(lane.get("head"), 128), "phase": text(lane.get("phase"), 200),
                      "percent": percent, "held": held, "next": text(lane.get("next")),
                      "stateNote": text(lane.get("state_note")), "updated": text(lane.get("updated"), 100)})
    lanes.sort(key=lambda row: row["id"])
    result = {"identity": identity, "context": context, "lanes": lanes[:30], "omittedLanes": max(0, len(lanes)-30)}
    result["id"] = hashlib.sha256(json.dumps(result, sort_keys=True).encode()).hexdigest()
    result["source"] = {"path": str(source.resolve()), "revision": hashlib.sha256(raw).hexdigest(),
                        "observedAt": datetime.datetime.fromtimestamp(now, datetime.timezone.utc).isoformat(),
                        "contextUpdated": record.get("updated")}
    if freshness == "current":
        result["expiresAt"] = updated + STALE_SECONDS
    elif freshness == "unknown" and updated is not None and updated > now:
        result["expiresAt"] = updated
    else:
        result["expiresAt"] = None
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--registry", required=True)
    parser.add_argument("--ladder-dir", required=True)
    parser.add_argument("--now", type=float)
    args = parser.parse_args()
    try:
        binding = json.loads(sys.stdin.read(16000))
        now = args.now if args.now is not None else datetime.datetime.now(datetime.timezone.utc).timestamp()
        print(json.dumps(snapshot(binding, args.registry, args.ladder_dir, now), ensure_ascii=False, separators=(',', ':')))
    except (OSError, ValueError, KeyError, ImportError) as error:
        print(json.dumps({"unavailable": str(error)}))
        sys.exit(1)
