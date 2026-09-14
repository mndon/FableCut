"""Bind human/model editorial evidence to a specific cut; never certify semantics."""
import hashlib
import json
import re

RULES = ("product", "meaning", "repetition", "hook", "constraints", "speech")


def fingerprint(sentences, selection, config, content):
    data = json.dumps([sentences, selection, config, content], ensure_ascii=False,
                      sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(data.encode()).hexdigest()


def findings(sentences, selection):
    indexed = {s["index"]: s for s in sentences["sentences"]}
    if any(type(i) is not int or i not in indexed for i in selection["keep_indices"]):
        raise ValueError("Unknown sentence index")
    result, previous = [], None
    for i in selection["keep_indices"]:
        text = re.sub(r"[\W_]", "", indexed[i]["text"])
        if re.search(r"(.{2,4})\1", text):
            result.append({"id": f"speech:{i}", "indices": [i], "reason": "疑似重复开头，复听或换句"})
        text = re.sub(r"^(?:(?:所以|然后|而且|像这个|这个|真的|你看|对))+", "", text)
        text = re.sub(r"不(?:需要|用)(?:去)?", "不用", text)
        if previous is not None:
            j, before = previous
            if min(len(before), len(text)) >= 4 and (text in before or before in text):
                result.append({"id": f"repeat:{j}:{i}", "indices": [j, i], "reason": "相邻表达包含或重复，检查是否有信息增量"})
        previous = i, text
    return result


def review_draft(sentences, selection, config, content):
    return {"fingerprint": fingerprint(sentences, selection, config, content),
            "checks": [{"rule": rule, "indices": [], "status": "pending", "evidence": ""} for rule in RULES],
            "issues": [{**issue, "status": "pending", "resolution": ""} for issue in findings(sentences, selection)],
            "media": {kind: {"status": "pending", "evidence": ""} for kind in ("visual", "audio")}}


def validate_review(sentences, selection, config, content, review):
    if not review or review.get("fingerprint") != fingerprint(sentences, selection, config, content):
        raise ValueError("Missing/stale editorial review; review the current cut")
    selected = set(selection["keep_indices"])
    checks = review.get("checks", [])
    if sorted(c.get("rule", "") for c in checks) != sorted(RULES):
        raise ValueError("Review must cover each editorial rule once")
    for check in checks:
        ids = check.get("indices", [])
        if check.get("status") != "pass" or not str(check.get("evidence", "")).strip() or not ids or any(type(i) is not int or i not in selected for i in ids):
            raise ValueError(f"Incomplete editorial evidence: {check['rule']}")
        if check["rule"] != "hook" and set(ids) != selected:
            raise ValueError(f"Editorial check must cover every selected index: {check['rule']}")
    issues = review.get("issues", [])
    if len({i["id"] for i in issues}) != len(issues):
        raise ValueError("Duplicate review issue IDs")
    if not {i["id"] for i in findings(sentences, selection)}.issubset({i["id"] for i in issues}):
        raise ValueError("Review omits detected wording risks")
    for issue in issues:
        if issue.get("status") not in ("resolved", "dismissed") or not str(issue.get("resolution", "")).strip():
            raise ValueError("Unresolved editorial issue")
    for kind in ("visual", "audio"):
        item = review.get("media", {}).get(kind, {})
        if item.get("status") not in ("pass", "pending", "unavailable"):
            raise ValueError(f"Invalid media review state: {kind}")
        if item["status"] != "pending" and not str(item.get("evidence", "")).strip():
            raise ValueError(f"Media review needs evidence/reason: {kind}")
