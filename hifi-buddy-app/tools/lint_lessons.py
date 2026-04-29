#!/usr/bin/env python3
"""Higher-level sanity checks for hifi-guide.json lessons.

Stdlib only. Complements tools/validate_data.py with cross-field checks
the schema validator can't catch:

- Every listenFor[].time segment ends at or before track.duration.
- Segments don't time-travel (start of segment N+1 >= start of segment N).
  Overlap is allowed.
- Top-level lesson.skills is a superset of skills used in listenFor[].skill.
- track.musicbrainzRecordingId matches MBID format if present.
- abx.segment (when not skip) matches one of the lesson's listenFor time
  strings.
- Lessons whose track is an audiophile pressing have abx.skip == true.

Usage:
    python3 tools/lint_lessons.py [hifi-guide.json]

Exit codes:
    0 - all lessons clean
    1 - one or more warnings
"""
from __future__ import annotations

import json
import os
import re
import sys
from typing import Any

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_FILE = os.path.join(REPO_ROOT, "data", "hifi-guide.json")

SEGMENT_RE = re.compile(r"^(\d+):([0-5]\d)-(\d+):([0-5]\d)$")
TIME_RE = re.compile(r"^(\d+):([0-5]\d)$")
MBID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)


def parse_time(s: str) -> int | None:
    m = TIME_RE.match(s)
    if not m:
        return None
    return int(m.group(1)) * 60 + int(m.group(2))


def parse_segment(s: str) -> tuple[int, int] | None:
    m = SEGMENT_RE.match(s)
    if not m:
        return None
    start = int(m.group(1)) * 60 + int(m.group(2))
    end = int(m.group(3)) * 60 + int(m.group(4))
    return start, end


def lint_lesson(lesson: dict) -> list[str]:
    lid = lesson.get("id", "<unknown>")
    issues: list[str] = []

    track = lesson.get("track") or {}
    guide = lesson.get("guide") or {}
    listen_for = guide.get("listenFor") or []
    top_skills = lesson.get("skills") or []

    # ---- duration -----------------------------------------------------
    duration_str = track.get("duration")
    duration_secs = parse_time(duration_str) if isinstance(duration_str, str) else None

    # ---- segments overrun / chronology --------------------------------
    last_start = -1
    for i, lf in enumerate(listen_for):
        if not isinstance(lf, dict):
            continue
        seg = lf.get("time")
        parsed = parse_segment(seg) if isinstance(seg, str) else None
        if parsed is None:
            continue  # validate_data.py handles malformed segments
        start, end = parsed
        if end < start:
            issues.append(
                f"{lid}: listenFor[{i}] segment '{seg}' ends before it starts"
            )
        if duration_secs is not None and end > duration_secs:
            issues.append(
                f"{lid}: listenFor[{i}] segment '{seg}' ends after track "
                f"duration ({duration_str})"
            )
        if start < last_start:
            issues.append(
                f"{lid}: listenFor[{i}] segment '{seg}' starts before previous "
                f"segment (out of chronological order)"
            )
        last_start = start

    # ---- skills coverage ---------------------------------------------
    used_skills = set()
    for lf in listen_for:
        if isinstance(lf, dict):
            sk = lf.get("skill")
            if isinstance(sk, str):
                used_skills.add(sk)
    declared = set(s for s in top_skills if isinstance(s, str))
    missing = used_skills - declared
    if missing:
        issues.append(
            f"{lid}: listenFor uses skill(s) {sorted(missing)} not declared in "
            f"lesson.skills {sorted(declared)}"
        )

    # ---- MBID format --------------------------------------------------
    mbid = track.get("musicbrainzRecordingId")
    if isinstance(mbid, str) and not MBID_RE.match(mbid):
        issues.append(
            f"{lid}: track.musicbrainzRecordingId '{mbid}' doesn't match MBID "
            f"format (8-4-4-4-12 lowercase hex)"
        )

    # ---- abx checks ---------------------------------------------------
    abx = lesson.get("abx")
    audiophile = bool(track.get("audiophilePressing"))
    if audiophile:
        if not isinstance(abx, dict) or abx.get("skip") is not True:
            issues.append(
                f"{lid}: track.audiophilePressing is true but abx.skip is not "
                f"true (audiophile pressings can't be ABX-tested on streaming)"
            )
    if isinstance(abx, dict) and not abx.get("skip"):
        seg = abx.get("segment")
        if isinstance(seg, str):
            segments = {
                lf.get("time")
                for lf in listen_for
                if isinstance(lf, dict) and isinstance(lf.get("time"), str)
            }
            if seg not in segments:
                issues.append(
                    f"{lid}: abx.segment '{seg}' is not one of the lesson's "
                    f"listenFor time strings"
                )

    return issues


def main(argv: list[str]) -> int:
    path = argv[1] if len(argv) > 1 else DEFAULT_FILE
    name = os.path.basename(path)

    if not os.path.exists(path):
        print(f"[FAIL] {name}")
        print(f"  - file not found at {path}")
        return 1

    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        print(f"[FAIL] {name}")
        print(f"  - JSON parse error: {e}")
        return 1

    lessons = data.get("lessons") if isinstance(data, dict) else None
    if not isinstance(lessons, list):
        print(f"[FAIL] {name}")
        print("  - expected object with 'lessons' array")
        return 1

    all_issues: list[str] = []
    for lesson in lessons:
        if not isinstance(lesson, dict):
            continue
        all_issues.extend(lint_lesson(lesson))

    if not all_issues:
        print(f"[PASS] {name} - {len(lessons)} lessons, 0 warnings")
        return 0

    print(f"[FAIL] {name}")
    for msg in all_issues:
        print(f"  - {msg}")
    print(f"  ({len(lessons)} lessons, {len(all_issues)} warnings)")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
