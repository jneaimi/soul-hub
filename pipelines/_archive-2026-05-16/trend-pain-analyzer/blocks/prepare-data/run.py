#!/usr/bin/env python3
"""prepare-data — Clean, deduplicate, and structure comments for AI pain analysis."""
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent.parent / "_builder" / "components"))
from error_handler import with_error_handling
from output_writer import write_output
from progress import report_progress, report_status

PIPELINE_DIR = Path(os.environ.get("PIPELINE_DIR", str(Path(__file__).resolve().parent.parent)))
INPUT_PATH = os.environ.get("PIPELINE_INPUT", "")

# Stopwords for key phrase extraction (EN + AR common)
STOPWORDS = {
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
    "do", "does", "did", "will", "would", "could", "should", "may", "might", "can", "shall",
    "to", "of", "in", "for", "on", "with", "at", "by", "from", "as", "into", "about", "like",
    "this", "that", "it", "its", "they", "them", "their", "he", "she", "we", "you", "i", "my",
    "and", "or", "but", "not", "no", "so", "if", "just", "very", "really", "more", "than",
    "what", "how", "who", "when", "where", "which", "all", "some", "any", "much", "many",
    "هذا", "هذه", "في", "من", "على", "إلى", "عن", "مع", "هو", "هي", "أن", "لا", "ما",
    "كل", "بعض", "أي", "لكن", "أو", "و", "ان", "الي", "اللي", "يعني", "بس",
}

# Sentiment markers
NEGATIVE_MARKERS = [
    "hate", "frustrating", "terrible", "broken", "expensive", "worst", "awful", "horrible",
    "useless", "disappointed", "annoying", "slow", "buggy", "scam", "waste", "sucks",
    "can't", "doesn't work", "not working", "poor quality", "overpriced", "misleading",
    "سيء", "مشكلة", "غالي", "ما يشتغل", "خربان", "محبط", "زبالة", "نصب",
]
POSITIVE_MARKERS = [
    "love", "great", "perfect", "amazing", "excellent", "awesome", "fantastic", "best",
    "helpful", "recommend", "changed my life", "game changer", "worth it", "impressed",
    "ممتاز", "رائع", "حلو", "جميل", "أفضل", "يستاهل", "عجبني", "مبدع",
]
REQUEST_MARKERS = [
    "wish", "should", "need", "please add", "would be nice", "feature request", "hoping",
    "can you add", "it would help", "missing", "they need to", "suggestion",
    "ياليت", "نبي", "نحتاج", "لو سمحت", "ضيفوا", "ناقص",
]

JACCARD_THRESHOLD = 0.85


def normalize_text(text):
    """Normalize text for deduplication: lowercase, collapse whitespace, strip punctuation."""
    t = text.lower().strip()
    t = re.sub(r"[^\w\s]", " ", t)
    t = re.sub(r"\s+", " ", t)
    return t


def jaccard_similarity(set_a, set_b):
    """Jaccard similarity between two word sets."""
    if not set_a or not set_b:
        return 0.0
    intersection = set_a & set_b
    union = set_a | set_b
    return len(intersection) / len(union)


def deduplicate_comments(comments):
    """Remove near-duplicate comments, keeping the one with higher likes."""
    # Group by normalized first-100-char key
    buckets = defaultdict(list)
    for c in comments:
        key = normalize_text(c.get("text", ""))[:100]
        buckets[key].append(c)

    deduped = []
    for key, group in buckets.items():
        if len(group) == 1:
            deduped.append(group[0])
            continue

        # Within same bucket, do Jaccard check for true duplicates
        kept = []
        for c in sorted(group, key=lambda x: x.get("likes", 0), reverse=True):
            c_words = set(normalize_text(c.get("text", "")).split())
            is_dup = False
            for k in kept:
                k_words = set(normalize_text(k.get("text", "")).split())
                if jaccard_similarity(c_words, k_words) >= JACCARD_THRESHOLD:
                    is_dup = True
                    break
            if not is_dup:
                kept.append(c)
        deduped.extend(kept)

    return deduped


def extract_key_phrases(texts, top_n=10):
    """Extract top key phrases using bigram and trigram frequency."""
    ngram_counter = Counter()

    for text in texts:
        words = [w for w in normalize_text(text).split() if w not in STOPWORDS and len(w) > 2]
        # Bigrams
        for i in range(len(words) - 1):
            ngram_counter[f"{words[i]} {words[i+1]}"] += 1
        # Trigrams
        for i in range(len(words) - 2):
            ngram_counter[f"{words[i]} {words[i+1]} {words[i+2]}"] += 1

    # Filter phrases that appear at least twice
    return [phrase for phrase, count in ngram_counter.most_common(top_n) if count >= 2]


def count_sentiment_signals(texts):
    """Count sentiment signals across comments using keyword heuristics."""
    negative = 0
    positive = 0
    questions = 0
    requests = 0

    for text in texts:
        t_lower = text.lower()
        if any(m in t_lower for m in NEGATIVE_MARKERS):
            negative += 1
        if any(m in t_lower for m in POSITIVE_MARKERS):
            positive += 1
        if text.strip().endswith("?") or "؟" in text:
            questions += 1
        if any(m in t_lower for m in REQUEST_MARKERS):
            requests += 1

    return {
        "negative_count": negative,
        "positive_count": positive,
        "question_count": questions,
        "request_count": requests,
    }


def main():
    report_status("Loading comments")

    if not INPUT_PATH or not Path(INPUT_PATH).exists():
        write_output({"status": "error", "message": "No input from comment-collector", "groups": []})
        return

    with open(INPUT_PATH) as f:
        data = json.load(f)

    raw_comments = data.get("comments", [])
    if not raw_comments:
        write_output({"status": "no_comments", "message": "No comments to prepare", "groups": [], "meta": {}})
        return

    total_raw = len(raw_comments)
    report_progress(10, f"Loaded {total_raw} raw comments")

    # Step 1: Deduplicate
    report_progress(20, "Deduplicating comments")
    comments = deduplicate_comments(raw_comments)
    duplicates_removed = total_raw - len(comments)

    # Step 2: Group by trend_title (fallback to search_query)
    report_progress(40, "Grouping by trend")
    groups_map = defaultdict(list)
    for c in comments:
        group_key = c.get("trend_title") or c.get("search_query") or "ungrouped"
        groups_map[group_key].append(c)

    # Step 3: Build structured groups
    report_progress(60, "Computing stats and signals")
    groups = []
    all_platforms = set()

    for idx, (title, group_comments) in enumerate(
        sorted(groups_map.items(), key=lambda x: len(x[1]), reverse=True), start=1
    ):
        texts = [c.get("text", "") for c in group_comments]
        platforms = list({c.get("platform", "") for c in group_comments if c.get("platform")})
        all_platforms.update(platforms)

        total_likes = sum(c.get("likes", 0) for c in group_comments)
        total_replies = sum(c.get("reply_count", 0) for c in group_comments)
        comment_count = len(group_comments)

        groups.append({
            "group_id": idx,
            "trend_title": title,
            "search_query": group_comments[0].get("search_query", "") if group_comments else "",
            "platforms": platforms,
            "stats": {
                "comment_count": comment_count,
                "total_likes": total_likes,
                "avg_likes": round(total_likes / comment_count, 1) if comment_count else 0,
                "total_replies": total_replies,
            },
            "key_phrases": extract_key_phrases(texts),
            "sentiment_signals": count_sentiment_signals(texts),
            "comments": [
                {
                    "text": c.get("text", ""),
                    "author": c.get("author", ""),
                    "platform": c.get("platform", ""),
                    "likes": c.get("likes", 0),
                    "reply_count": c.get("reply_count", 0),
                }
                for c in sorted(group_comments, key=lambda x: x.get("likes", 0), reverse=True)
            ],
        })

    result = {
        "status": "ok",
        "meta": {
            "total_raw_comments": total_raw,
            "total_after_dedup": len(comments),
            "duplicates_removed": duplicates_removed,
            "groups_count": len(groups),
            "platforms_represented": sorted(all_platforms),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
        "groups": groups,
    }

    write_output(result)
    report_progress(100, f"Done — {len(groups)} groups, {len(comments)} comments ({duplicates_removed} dupes removed)")


if __name__ == "__main__":
    with_error_handling(main)()
