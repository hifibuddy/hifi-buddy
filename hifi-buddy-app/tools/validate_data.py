#!/usr/bin/env python3
"""Validate HiFi Buddy data files against inline schemas.

Stdlib only. No jsonschema dependency.

Usage:
    python3 tools/validate_data.py [data_file ...]

Defaults to validating all four canonical data files in data/ when no
arguments are passed.

Exit codes:
    0 - all files passed
    1 - one or more files failed validation
"""
from __future__ import annotations

import json
import os
import re
import sys
from typing import Any, Callable

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(REPO_ROOT, "data")

DEFAULT_FILES = [
    os.path.join(DATA_DIR, "hifi-guide.json"),
    os.path.join(DATA_DIR, "reference-clips.json"),
    os.path.join(DATA_DIR, "reference-catalog.json"),
    os.path.join(DATA_DIR, "headphones-fr.json"),
]

CANONICAL_SKILL_IDS = {
    "soundstage",
    "imaging",
    "detail",
    "dynamics",
    "tonal-color",
    "bass",
    "separation",
    "transients",
    "air",
    "layering",
}

VALID_DIFFICULTIES = {"beginner", "intermediate", "advanced"}
VALID_HEADPHONE_TYPES = {"open-back", "closed-back", "iem", "planar", "hybrid"}

TIME_RE = re.compile(r"^\d+:[0-5]\d$")
SEGMENT_RE = re.compile(r"^\d+:[0-5]\d-\d+:[0-5]\d$")
MBID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


# ---------------------------------------------------------------------------
# Error collection helper
# ---------------------------------------------------------------------------


class Errors:
    def __init__(self) -> None:
        self._errors: list[str] = []

    def add(self, msg: str) -> None:
        self._errors.append(msg)

    def extend(self, msgs: list[str]) -> None:
        self._errors.extend(msgs)

    def __len__(self) -> int:
        return len(self._errors)

    def __iter__(self):
        return iter(self._errors)


# ---------------------------------------------------------------------------
# Primitive validators
# ---------------------------------------------------------------------------


def is_string(v: Any) -> bool:
    return isinstance(v, str)


def is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def is_bool(v: Any) -> bool:
    return isinstance(v, bool)


def is_list(v: Any) -> bool:
    return isinstance(v, list)


def is_dict(v: Any) -> bool:
    return isinstance(v, dict)


def require_keys(
    obj: dict, required: list[str], path: str, errors: Errors
) -> None:
    for k in required:
        if k not in obj:
            errors.add(f"{path}: missing required key '{k}'")


def reject_unknown(
    obj: dict, allowed: set[str], path: str, errors: Errors
) -> None:
    for k in obj:
        if k not in allowed:
            errors.add(f"{path}: unknown key '{k}'")


# ---------------------------------------------------------------------------
# hifi-guide.json
# ---------------------------------------------------------------------------


SKILL_REQUIRED = {"id", "name", "icon", "color", "description", "tip"}

LESSON_REQUIRED = {"id", "title", "difficulty", "skills", "album", "track", "guide"}
LESSON_OPTIONAL = {"abx", "equipment", "generated", "generatedAt", "venue"}
LESSON_ALLOWED = LESSON_REQUIRED | LESSON_OPTIONAL

VALID_VENUE_TYPES = {
    "concert-hall", "studio", "jazz-club", "church", "home-studio", "other",
}
ACCEPTED_VENUE_LICENSES = {
    "CC BY 4.0", "CC BY-SA 4.0",
    "CC BY 3.0", "CC BY-SA 3.0",
    "CC BY 2.0", "CC BY-SA 2.0",
    "CC0", "public domain", "GFDL",
}
VENUE_REQUIRED = {"name", "location", "type", "caption"}
VENUE_OPTIONAL = {"year", "image"}
VENUE_ALLOWED = VENUE_REQUIRED | VENUE_OPTIONAL

VENUE_IMAGE_REQUIRED = {"url", "alt", "license", "author", "sourceUrl"}
VENUE_IMAGE_OPTIONAL = {"thumbnailUrl"}
VENUE_IMAGE_ALLOWED = VENUE_IMAGE_REQUIRED | VENUE_IMAGE_OPTIONAL

URL_RE = re.compile(r"^https?://[a-zA-Z0-9.\-]+/")

ALBUM_REQUIRED = {"title", "artist", "year", "genre", "label", "format"}
ALBUM_OPTIONAL = {"masteredBy"}
ALBUM_ALLOWED = ALBUM_REQUIRED | ALBUM_OPTIONAL

TRACK_REQUIRED = {"title", "duration"}
TRACK_OPTIONAL = {"versionNote", "musicbrainzRecordingId", "audiophilePressing"}
TRACK_ALLOWED = TRACK_REQUIRED | TRACK_OPTIONAL

GUIDE_REQUIRED = {"intro", "listenFor", "takeaway"}

LISTEN_REQUIRED = {"time", "skill", "note"}
# Lessons in current data carry extra optional descriptor fields.
LISTEN_OPTIONAL = {"headphoneNote", "weakOn", "bestRevealedBy"}
LISTEN_ALLOWED = LISTEN_REQUIRED | LISTEN_OPTIONAL


def validate_hifi_guide(data: Any) -> tuple[Errors, dict]:
    errors = Errors()
    summary: dict = {"skills": 0, "lessons": 0}

    if not is_dict(data):
        errors.add("root: expected object with 'skills' and 'lessons'")
        return errors, summary

    require_keys(data, ["skills", "lessons"], "root", errors)
    if errors:
        return errors, summary

    # ---- skills -----------------------------------------------------------
    skills = data["skills"]
    if not is_list(skills):
        errors.add("skills: expected array")
        return errors, summary

    seen_skill_ids: set[str] = set()
    for i, s in enumerate(skills):
        path = f"skills[{i}]"
        if not is_dict(s):
            errors.add(f"{path}: expected object")
            continue
        require_keys(s, sorted(SKILL_REQUIRED), path, errors)
        for key in ("id", "name", "icon", "color", "description", "tip"):
            if key in s and not is_string(s[key]):
                errors.add(f"{path}.{key}: expected string")
        sid = s.get("id")
        if isinstance(sid, str):
            if sid in seen_skill_ids:
                errors.add(f"{path}: duplicate skill id '{sid}'")
            seen_skill_ids.add(sid)
            if sid not in CANONICAL_SKILL_IDS:
                errors.add(
                    f"{path}: id '{sid}' is not one of the 10 canonical skill ids"
                )

    summary["skills"] = len(skills)

    # ---- lessons ----------------------------------------------------------
    lessons = data["lessons"]
    if not is_list(lessons):
        errors.add("lessons: expected array")
        return errors, summary

    seen_lesson_ids: set[str] = set()
    for i, l in enumerate(lessons):
        lid = l.get("id", f"#{i}") if is_dict(l) else f"#{i}"
        path = f"lesson {lid}"
        if not is_dict(l):
            errors.add(f"{path}: expected object")
            continue

        require_keys(l, sorted(LESSON_REQUIRED), path, errors)
        reject_unknown(l, LESSON_ALLOWED, path, errors)

        if "id" in l:
            if not is_string(l["id"]):
                errors.add(f"{path}.id: expected string")
            elif l["id"] in seen_lesson_ids:
                errors.add(f"{path}: duplicate lesson id")
            else:
                seen_lesson_ids.add(l["id"])

        if "title" in l and not is_string(l["title"]):
            errors.add(f"{path}.title: expected string")

        if "difficulty" in l:
            if l["difficulty"] not in VALID_DIFFICULTIES:
                errors.add(
                    f"{path}.difficulty: '{l['difficulty']}' not in "
                    f"{sorted(VALID_DIFFICULTIES)}"
                )

        if "skills" in l:
            sks = l["skills"]
            if not is_list(sks) or not sks:
                errors.add(f"{path}.skills: expected non-empty array")
            else:
                for j, sk in enumerate(sks):
                    if not is_string(sk):
                        errors.add(f"{path}.skills[{j}]: expected string")
                    elif sk not in CANONICAL_SKILL_IDS:
                        errors.add(
                            f"{path}.skills[{j}]: '{sk}' is not a valid skill id"
                        )

        # album
        if "album" in l:
            _validate_album(l["album"], f"{path}.album", errors)

        # track
        if "track" in l:
            _validate_track(l["track"], f"{path}.track", errors)

        # guide
        if "guide" in l:
            _validate_guide(l["guide"], f"{path}.guide", errors)

        # abx (optional)
        if "abx" in l:
            _validate_abx(l["abx"], f"{path}.abx", errors)

        # equipment (optional)
        if "equipment" in l:
            eq = l["equipment"]
            if not is_dict(eq):
                errors.add(f"{path}.equipment: expected object")
            else:
                for key in ("source", "whyItMatters"):
                    if key in eq and not is_string(eq[key]):
                        errors.add(f"{path}.equipment.{key}: expected string")

        # generated / generatedAt (optional, free-form)
        if "generatedAt" in l and not is_string(l["generatedAt"]):
            errors.add(f"{path}.generatedAt: expected string")

        # venue (optional)
        if "venue" in l:
            _validate_venue(l["venue"], f"{path}.venue", errors)

    summary["lessons"] = len(lessons)
    return errors, summary


def _validate_album(album: Any, path: str, errors: Errors) -> None:
    if not is_dict(album):
        errors.add(f"{path}: expected object")
        return
    require_keys(album, sorted(ALBUM_REQUIRED), path, errors)
    reject_unknown(album, ALBUM_ALLOWED, path, errors)
    for key in ("title", "artist", "genre", "label", "format"):
        if key in album and not is_string(album[key]):
            errors.add(f"{path}.{key}: expected string")
    if "year" in album and not is_int(album["year"]):
        errors.add(f"{path}.year: expected integer")
    if "masteredBy" in album and not is_string(album["masteredBy"]):
        errors.add(f"{path}.masteredBy: expected string")


def _validate_track(track: Any, path: str, errors: Errors) -> None:
    if not is_dict(track):
        errors.add(f"{path}: expected object")
        return
    require_keys(track, sorted(TRACK_REQUIRED), path, errors)
    reject_unknown(track, TRACK_ALLOWED, path, errors)
    if "title" in track and not is_string(track["title"]):
        errors.add(f"{path}.title: expected string")
    if "duration" in track:
        if not is_string(track["duration"]) or not TIME_RE.match(track["duration"]):
            errors.add(
                f"{path}.duration: '{track.get('duration')}' doesn't match M:SS pattern"
            )
    if "versionNote" in track and not is_string(track["versionNote"]):
        errors.add(f"{path}.versionNote: expected string")
    if "musicbrainzRecordingId" in track:
        mbid = track["musicbrainzRecordingId"]
        if not is_string(mbid):
            errors.add(f"{path}.musicbrainzRecordingId: expected string")
        # MBID format check is enforced more strictly in lint_lessons.py
    if "audiophilePressing" in track and not is_bool(track["audiophilePressing"]):
        errors.add(f"{path}.audiophilePressing: expected boolean")


def _validate_guide(guide: Any, path: str, errors: Errors) -> None:
    if not is_dict(guide):
        errors.add(f"{path}: expected object")
        return
    require_keys(guide, sorted(GUIDE_REQUIRED), path, errors)
    if "intro" in guide and not is_string(guide["intro"]):
        errors.add(f"{path}.intro: expected string")
    if "takeaway" in guide and not is_string(guide["takeaway"]):
        errors.add(f"{path}.takeaway: expected string")
    lf = guide.get("listenFor")
    if lf is None:
        return
    if not is_list(lf) or not lf:
        errors.add(f"{path}.listenFor: expected non-empty array")
        return
    for j, entry in enumerate(lf):
        epath = f"{path}.listenFor[{j}]"
        if not is_dict(entry):
            errors.add(f"{epath}: expected object")
            continue
        require_keys(entry, sorted(LISTEN_REQUIRED), epath, errors)
        reject_unknown(entry, LISTEN_ALLOWED, epath, errors)
        if "time" in entry:
            t = entry["time"]
            if not is_string(t) or not SEGMENT_RE.match(t):
                errors.add(
                    f"{epath}.time: '{t}' doesn't match M:SS-M:SS pattern"
                )
        if "skill" in entry:
            sk = entry["skill"]
            if not is_string(sk):
                errors.add(f"{epath}.skill: expected string")
            elif sk not in CANONICAL_SKILL_IDS:
                errors.add(f"{epath}.skill: '{sk}' is not a valid skill id")
        if "note" in entry and not is_string(entry["note"]):
            errors.add(f"{epath}.note: expected string")


def _validate_abx(abx: Any, path: str, errors: Errors) -> None:
    if not is_dict(abx):
        errors.add(f"{path}: expected object")
        return
    # abx is loose: either a "skip" form or a normal form. Validate types we know.
    if "skip" in abx and not is_bool(abx["skip"]):
        errors.add(f"{path}.skip: expected boolean")
    if "segment" in abx:
        seg = abx["segment"]
        if not is_string(seg) or not SEGMENT_RE.match(seg):
            errors.add(
                f"{path}.segment: '{seg}' doesn't match M:SS-M:SS pattern"
            )
    if "skill" in abx:
        sk = abx["skill"]
        if not is_string(sk):
            errors.add(f"{path}.skill: expected string")
        elif sk not in CANONICAL_SKILL_IDS:
            errors.add(f"{path}.skill: '{sk}' is not a valid skill id")
    if "defaultBitrate" in abx and not is_int(abx["defaultBitrate"]):
        errors.add(f"{path}.defaultBitrate: expected integer")
    for key in ("rationale", "reason"):
        if key in abx and not is_string(abx[key]):
            errors.add(f"{path}.{key}: expected string")


def _validate_venue(venue: Any, path: str, errors: Errors) -> None:
    """Validate the optional `venue` block on a lesson.

    Schema:
        - name (string, non-empty)
        - location (string, non-empty)
        - type (one of VALID_VENUE_TYPES)
        - caption (string, non-empty)
        - year (int 1700..current_year, optional)
        - image (object, optional but if present its sub-fields are required)
    """
    import datetime
    current_year = datetime.datetime.now().year

    if not is_dict(venue):
        errors.add(f"{path}: expected object")
        return

    require_keys(venue, sorted(VENUE_REQUIRED), path, errors)
    reject_unknown(venue, VENUE_ALLOWED, path, errors)

    for key in ("name", "location", "caption"):
        if key in venue:
            v = venue[key]
            if not is_string(v):
                errors.add(f"{path}.{key}: expected string")
            elif not v.strip():
                errors.add(f"{path}.{key}: expected non-empty string")

    if "type" in venue:
        t = venue["type"]
        if t not in VALID_VENUE_TYPES:
            errors.add(
                f"{path}.type: '{t}' not in {sorted(VALID_VENUE_TYPES)}"
            )

    if "year" in venue:
        y = venue["year"]
        if not is_int(y):
            errors.add(f"{path}.year: expected integer")
        elif y < 1700 or y > current_year:
            errors.add(
                f"{path}.year: {y} out of range 1700..{current_year}"
            )

    if "image" in venue:
        _validate_venue_image(venue["image"], f"{path}.image", errors)


def _validate_venue_image(img: Any, path: str, errors: Errors) -> None:
    if not is_dict(img):
        errors.add(f"{path}: expected object")
        return

    require_keys(img, sorted(VENUE_IMAGE_REQUIRED), path, errors)
    reject_unknown(img, VENUE_IMAGE_ALLOWED, path, errors)

    for key in ("alt", "license", "author", "sourceUrl"):
        if key in img:
            v = img[key]
            if not is_string(v):
                errors.add(f"{path}.{key}: expected string")
            elif not v.strip():
                errors.add(f"{path}.{key}: expected non-empty string")

    for key in ("url", "thumbnailUrl"):
        if key in img:
            u = img[key]
            if not is_string(u):
                errors.add(f"{path}.{key}: expected string")
            elif not URL_RE.match(u):
                errors.add(
                    f"{path}.{key}: '{u}' is not a valid http(s) URL"
                )

    if "sourceUrl" in img and is_string(img["sourceUrl"]):
        if not URL_RE.match(img["sourceUrl"]):
            errors.add(
                f"{path}.sourceUrl: '{img['sourceUrl']}' is not a valid http(s) URL"
            )

    if "license" in img and is_string(img["license"]):
        if img["license"] not in ACCEPTED_VENUE_LICENSES:
            # Warn but don't fail — the brief says unknown licenses warn.
            print(
                f"  [warn] {path}.license: '{img['license']}' is not in the "
                f"recognized CC variants list (allowing through)."
            )


# ---------------------------------------------------------------------------
# reference-clips.json
# ---------------------------------------------------------------------------


CLIP_REQUIRED = {
    "id", "title", "track", "artist", "album", "year", "genre",
    "segment", "skills", "characteristic", "description", "difficulty",
}
CLIP_OPTIONAL = {"audiophilePressing"}
CLIP_ALLOWED = CLIP_REQUIRED | CLIP_OPTIONAL


def validate_reference_clips(data: Any) -> tuple[Errors, dict]:
    errors = Errors()
    summary: dict = {"clips": 0}
    if not is_list(data):
        errors.add("root: expected array of clips")
        return errors, summary

    seen: set[str] = set()
    for i, c in enumerate(data):
        cid = c.get("id", f"#{i}") if is_dict(c) else f"#{i}"
        path = f"clip {cid}"
        if not is_dict(c):
            errors.add(f"{path}: expected object")
            continue
        require_keys(c, sorted(CLIP_REQUIRED), path, errors)
        reject_unknown(c, CLIP_ALLOWED, path, errors)

        if "id" in c:
            if not is_string(c["id"]):
                errors.add(f"{path}.id: expected string")
            elif c["id"] in seen:
                errors.add(f"{path}: duplicate clip id")
            else:
                seen.add(c["id"])

        for key in ("title", "track", "artist", "album", "genre",
                    "characteristic", "description"):
            if key in c and not is_string(c[key]):
                errors.add(f"{path}.{key}: expected string")
        if "year" in c and not is_int(c["year"]):
            errors.add(f"{path}.year: expected integer")
        if "segment" in c:
            seg = c["segment"]
            if not is_string(seg) or not SEGMENT_RE.match(seg):
                errors.add(
                    f"{path}: segment '{seg}' doesn't match M:SS-M:SS pattern"
                )
        if "difficulty" in c and c["difficulty"] not in VALID_DIFFICULTIES:
            errors.add(
                f"{path}.difficulty: '{c['difficulty']}' not in "
                f"{sorted(VALID_DIFFICULTIES)}"
            )
        if "skills" in c:
            sks = c["skills"]
            if not is_list(sks) or not sks:
                errors.add(f"{path}.skills: expected non-empty array")
            else:
                for j, sk in enumerate(sks):
                    if not is_string(sk):
                        errors.add(f"{path}.skills[{j}]: expected string")
                    elif sk not in CANONICAL_SKILL_IDS:
                        errors.add(
                            f"{path}: skill '{sk}' is not a valid skill ID "
                            f"(valid: {', '.join(sorted(CANONICAL_SKILL_IDS))})"
                        )
        if "audiophilePressing" in c and not is_bool(c["audiophilePressing"]):
            errors.add(f"{path}.audiophilePressing: expected boolean")

    summary["clips"] = len(data)
    return errors, summary


# ---------------------------------------------------------------------------
# reference-catalog.json
# ---------------------------------------------------------------------------


CATALOG_REQUIRED = {
    "id", "track", "artist", "album", "year", "genre",
    "primarySkills", "difficulty", "audiophileNote",
}


def validate_reference_catalog(data: Any) -> tuple[Errors, dict]:
    errors = Errors()
    summary: dict = {"candidates": 0}
    if not is_list(data):
        errors.add("root: expected array of catalog entries")
        return errors, summary

    seen: set[str] = set()
    for i, c in enumerate(data):
        cid = c.get("id", f"#{i}") if is_dict(c) else f"#{i}"
        path = f"catalog {cid}"
        if not is_dict(c):
            errors.add(f"{path}: expected object")
            continue
        require_keys(c, sorted(CATALOG_REQUIRED), path, errors)
        reject_unknown(c, CATALOG_REQUIRED, path, errors)

        if "id" in c:
            if not is_string(c["id"]):
                errors.add(f"{path}.id: expected string")
            elif c["id"] in seen:
                errors.add(f"{path}: duplicate catalog id")
            else:
                seen.add(c["id"])

        for key in ("track", "artist", "album", "genre", "audiophileNote"):
            if key in c and not is_string(c[key]):
                errors.add(f"{path}.{key}: expected string")
        if "year" in c and not is_int(c["year"]):
            errors.add(f"{path}.year: expected integer")
        if "difficulty" in c and c["difficulty"] not in VALID_DIFFICULTIES:
            errors.add(
                f"{path}.difficulty: '{c['difficulty']}' not in "
                f"{sorted(VALID_DIFFICULTIES)}"
            )
        if "primarySkills" in c:
            sks = c["primarySkills"]
            if not is_list(sks) or not sks:
                errors.add(f"{path}.primarySkills: expected non-empty array")
            else:
                for j, sk in enumerate(sks):
                    if not is_string(sk):
                        errors.add(f"{path}.primarySkills[{j}]: expected string")
                    elif sk not in CANONICAL_SKILL_IDS:
                        errors.add(
                            f"{path}: primarySkill '{sk}' is not a valid skill ID"
                        )

    summary["candidates"] = len(data)
    return errors, summary


# ---------------------------------------------------------------------------
# headphones-fr.json
# ---------------------------------------------------------------------------


HP_REQUIRED = {"id", "name", "type", "fr", "notes"}


def validate_headphones_fr(data: Any) -> tuple[Errors, dict]:
    errors = Errors()
    summary: dict = {"entries": 0}
    if not is_list(data):
        errors.add("root: expected array of headphone entries")
        return errors, summary

    seen: set[str] = set()
    for i, h in enumerate(data):
        hid = h.get("id", f"#{i}") if is_dict(h) else f"#{i}"
        path = f"headphone {hid}"
        if not is_dict(h):
            errors.add(f"{path}: expected object")
            continue
        require_keys(h, sorted(HP_REQUIRED), path, errors)
        reject_unknown(h, HP_REQUIRED, path, errors)

        if "id" in h:
            if not is_string(h["id"]):
                errors.add(f"{path}.id: expected string")
            elif h["id"] in seen:
                errors.add(f"{path}: duplicate headphone id")
            else:
                seen.add(h["id"])

        for key in ("name", "notes"):
            if key in h and not is_string(h[key]):
                errors.add(f"{path}.{key}: expected string")
        if "type" in h and h["type"] not in VALID_HEADPHONE_TYPES:
            errors.add(
                f"{path}.type: '{h['type']}' not in "
                f"{sorted(VALID_HEADPHONE_TYPES)}"
            )
        if "fr" in h:
            fr = h["fr"]
            if not is_list(fr):
                errors.add(f"{path}.fr: expected array of [Hz, dB] pairs")
            elif len(fr) < 20:
                errors.add(
                    f"{path}.fr: only {len(fr)} points, need >= 20"
                )
            else:
                for j, pair in enumerate(fr):
                    ppath = f"{path}.fr[{j}]"
                    if not is_list(pair) or len(pair) != 2:
                        errors.add(f"{ppath}: expected [Hz, dB] pair")
                        continue
                    hz, db = pair
                    if not is_number(hz):
                        errors.add(f"{ppath}: Hz must be a number")
                    elif hz <= 0:
                        errors.add(f"{ppath}: Hz must be > 0 (got {hz})")
                    if not is_number(db):
                        errors.add(f"{ppath}: dB must be a number")

    summary["entries"] = len(data)
    return errors, summary


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


VALIDATORS: dict[str, Callable[[Any], tuple[Errors, dict]]] = {
    "hifi-guide.json": validate_hifi_guide,
    "reference-clips.json": validate_reference_clips,
    "reference-catalog.json": validate_reference_catalog,
    "headphones-fr.json": validate_headphones_fr,
}


def _summary_string(name: str, summary: dict, error_count: int) -> str:
    if name == "hifi-guide.json":
        return (
            f"{summary.get('lessons', 0)} lessons, "
            f"{summary.get('skills', 0)} skills, "
            f"{error_count} errors"
        )
    if name == "reference-clips.json":
        return f"{summary.get('clips', 0)} clips, {error_count} errors"
    if name == "reference-catalog.json":
        return f"{summary.get('candidates', 0)} candidates, {error_count} errors"
    if name == "headphones-fr.json":
        return f"{summary.get('entries', 0)} entries, {error_count} errors"
    return f"{error_count} errors"


def validate_file(path: str) -> tuple[bool, int]:
    """Validate one data file. Returns (passed, error_count)."""
    name = os.path.basename(path)
    validator = VALIDATORS.get(name)
    if validator is None:
        print(f"[SKIP] {name} - no schema registered")
        return True, 0

    if not os.path.exists(path):
        print(f"[FAIL] {name}")
        print(f"  - file not found at {path}")
        return False, 1

    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        print(f"[FAIL] {name}")
        print(f"  - JSON parse error: {e}")
        return False, 1
    except OSError as e:
        print(f"[FAIL] {name}")
        print(f"  - read error: {e}")
        return False, 1

    errors, summary = validator(data)
    error_count = len(errors)
    if error_count == 0:
        print(f"[PASS] {name} - {_summary_string(name, summary, 0)}")
        return True, 0

    print(f"[FAIL] {name}")
    for msg in errors:
        print(f"  - {msg}")
    print(f"  ({_summary_string(name, summary, error_count)})")
    return False, error_count


def main(argv: list[str]) -> int:
    files = argv[1:] if len(argv) > 1 else DEFAULT_FILES
    passed_count = 0
    failed_count = 0
    total_errors = 0
    for path in files:
        passed, n = validate_file(path)
        if passed:
            passed_count += 1
        else:
            failed_count += 1
            total_errors += n

    total = passed_count + failed_count
    print()
    if failed_count == 0:
        print(f"All {total} file(s) passed.")
        return 0
    print(
        f"{passed_count} of {total} files passed. "
        f"{total_errors} error(s) total."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
