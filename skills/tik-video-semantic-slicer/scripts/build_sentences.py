"""Bridge untouched tik ASR JSON to stable, source-scoped phrase indices.

Split phrases by punctuation using reliable word timestamps. No timestamp interpolation.
"""
import argparse
import re
from pathlib import Path

from common import EPS, main_guard, number, read_json, unique_map, write_json

PUNCT = "，。！？；、：…,.!?;:\n—-"
PATTERN = re.compile(r"[^" + re.escape(PUNCT) + r"]+(?:[" + re.escape(PUNCT) + r"]+)?")


def convert_words(sentence, start, end):
    words = []
    previous = start
    for word in sentence.get("words") or []:
        text = (word.get("word") or "").strip()
        try:
            begin = number(word["begin_time"], "word.begin_time") / 1000
            finish = number(word["end_time"], "word.end_time") / 1000
        except (ValueError, TypeError, KeyError):
            return []
        if not text or begin < previous - EPS or finish <= begin or begin < start - EPS or finish > end + EPS:
            return []
        words.append({"start": begin, "end": finish, "word": text, "punc": word.get("punc") or ""})
        previous = finish
    return words


def split_by_punct(text, start, end, words):
    if not words:
        return [(text, start, end, [])]
    spans, position = [], 0
    for word in words:
        offset = text.find(word["word"], position)
        if offset < 0:
            return [(text, start, end, [])]
        position = offset + len(word["word"])
        spans.append((offset, position, word))
    chunks = []
    consumed = set()
    for match in PATTERN.finditer(text):
        chosen = [(i, w) for i, (a, b, w) in enumerate(spans) if b > match.start() and a < match.end()]
        if not chosen or any(i in consumed for i, _ in chosen):
            return [(text, start, end, words)]
        consumed.update(i for i, _ in chosen)
        selected = [w for _, w in chosen]
        chunks.append((match.group().strip(), selected[0]["start"], selected[-1]["end"], selected))
    if len(consumed) != len(words):
        return [(text, start, end, words)]
    return chunks or [(text, start, end, words)]


def build(sources, no_split=False):
    items = sources["sources"]
    if not items:
        raise ValueError("sources cannot be empty")
    unique_map(items, "id")
    sentences, summaries = [], []
    for source in items:
        sid = source["id"]
        if not re.fullmatch(r"[a-z][a-z0-9_-]*", sid):
            raise ValueError("Source IDs must be lowercase identifiers")
        if not Path(source["path"]).is_absolute() or not Path(source["transcript"]).is_absolute():
            raise ValueError("Source and transcript paths must be absolute")
        raw = read_json(source["transcript"])
        rich, speakers = raw["rich_result"], raw["speaker_mapping"]
        if not isinstance(speakers, dict):
            raise ValueError("speaker_mapping must be the original ASR object")
        total = number(rich["duration"], "ASR duration") / 1000
        lo, hi = source.get("range", [0, total])
        lo, hi = number(lo, "range.start"), number(hi, "range.end")
        if hi <= lo or hi > total + 0.5:
            raise ValueError(f"Invalid requested source range: {sid}")
        original = rich["sentences"]
        if not original:
            raise ValueError(f"Empty ASR transcript: {sid}")
        buckets, previous = {}, -1
        for raw_index, sentence in enumerate(original):
            start = number(sentence["begin_time"], "sentence.begin_time") / 1000
            end = number(sentence["end_time"], "sentence.end_time") / 1000
            if end <= start or start < previous or end > total + EPS:
                raise ValueError(f"Invalid/unordered ASR timestamp: {sid}:{raw_index}")
            previous = start
            text = sentence["text"].strip()
            if not text:
                raise ValueError(f"Empty ASR sentence text: {sid}:{raw_index}")
            cid = str(sentence["channel_id"])
            if cid not in speakers:
                raise ValueError(f"ASR speaker_mapping missing channel {cid}")
            speaker_id = f"{sid}:{cid}"
            label = speakers[cid]
            bucket = buckets.setdefault(speaker_id, {"speaker_id": speaker_id, "source_id": sid,
                "channel_id": cid, "label": label, "sentence_count": 0, "samples": []})
            bucket["sentence_count"] += 1
            if len(bucket["samples"]) < 5:
                bucket["samples"].append(text[:80])
            words = convert_words(sentence, start, end)
            chunks = [(text, start, end, words)] if no_split else split_by_punct(text, start, end, words)
            for phrase, begin, finish, phrase_words in chunks:
                sentences.append({"index": len(sentences), "source_id": sid,
                    "raw_sentence_index": raw_index, "start": begin, "end": finish,
                    "text": phrase, "speaker": label, "speaker_id": speaker_id,
                    "eligible": begin >= lo - EPS and finish <= hi + EPS, "words": phrase_words})
        for bucket in buckets.values():
            bucket["ratio"] = round(bucket["sentence_count"] / len(original), 3)
            summaries.append(bucket)
    return {"sentences": sentences}, {"speakers": summaries, "total_phrases": len(sentences)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--no-split", action="store_true", help="Only for an explicit whole-sentence request")
    args = parser.parse_args()
    out = Path(args.out)
    if (out / "sentences.json").exists():
        raise ValueError("sentences.json already exists; reuse stable indices or start a new run")
    sentences, summary = build(read_json(args.sources), args.no_split)
    write_json(out / "sentences.json", sentences)
    write_json(out / "speakers_summary.json", summary)
    print(f"[通过] {len(sentences['sentences'])} stable phrases; original ASR files untouched")


if __name__ == "__main__":
    main_guard(main)
