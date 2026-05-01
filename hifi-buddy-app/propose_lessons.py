#!/usr/bin/env python3
"""
propose_lessons.py — HiFi Buddy lesson-catalog expansion helper.

Reads `data/reference-catalog.json` (the audiophile candidate pool) and
`data/hifi-guide.json` (the live lesson catalog), intersects the candidates
with the user's Plex music library, scores them, and (optionally) drafts
full HiFi Buddy lessons for the top N candidates by calling the running
HiFi Buddy server's `/api/claude` or `/api/ollama` proxy.

Output: `proposed-lessons.json` — for human review BEFORE any merge into
the live `data/hifi-guide.json`.

Usage:
    python3 propose_lessons.py [options]

Stdlib only. No external deps.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from typing import Any


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

VALID_SKILLS = (
    'soundstage', 'imaging', 'detail', 'dynamics', 'tonal-color',
    'bass', 'separation', 'transients', 'air', 'layering',
)
VALID_DIFFICULTIES = ('beginner', 'intermediate', 'advanced')

GENRE_CLUSTERS = {
    'jazz': 'jazz',
    'rock': 'rock',
    'folk': 'folk',
    'classical': 'classical',
    'electronic': 'electronic',
    'soul': 'soul',
    'world': 'world',
}

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
HIFI_GUIDE_PATH = os.path.join(REPO_ROOT, 'data', 'hifi-guide.json')
CATALOG_PATH = os.path.join(REPO_ROOT, 'data', 'reference-catalog.json')

TIME_RE = re.compile(r'^(\d+):([0-5]\d)$')
RANGE_RE = re.compile(r'^(\d+):([0-5]\d)-(\d+):([0-5]\d)$')


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def normalize(s: str) -> str:
    """Lowercase, strip non-alphanumeric. Used for fuzzy artist/track match."""
    return re.sub(r'[^a-z0-9]', '', (s or '').lower())


def parse_secs(t: str) -> float:
    m = TIME_RE.match(t or '')
    if not m:
        return float('nan')
    return int(m.group(1)) * 60 + int(m.group(2))


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def vlog(verbose: bool, msg: str) -> None:
    if verbose:
        print(msg, flush=True)


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_existing_lessons() -> list[dict]:
    with open(HIFI_GUIDE_PATH, 'r', encoding='utf-8') as f:
        return json.load(f)['lessons']


def load_catalog() -> list[dict]:
    with open(CATALOG_PATH, 'r', encoding='utf-8') as f:
        return json.load(f)


def build_exclusion_set(lessons: list[dict]) -> set[tuple[str, str]]:
    """Return set of normalized (artist, track) pairs already taught."""
    out = set()
    for l in lessons:
        out.add((normalize(l['album']['artist']), normalize(l['track']['title'])))
    return out


def filter_candidates(catalog: list[dict],
                      excl: set[tuple[str, str]]) -> list[dict]:
    """Drop catalog entries that duplicate existing lessons."""
    out = []
    for e in catalog:
        key = (normalize(e['artist']), normalize(e['track']))
        if key not in excl:
            out.append(e)
    return out


def under_covered_skills(lessons: list[dict]) -> set[str]:
    """Per-segment skill counts; return the bottom 4 by frequency."""
    counts = {s: 0 for s in VALID_SKILLS}
    for l in lessons:
        for seg in l.get('guide', {}).get('listenFor', []):
            sk = seg.get('skill')
            if sk in counts:
                counts[sk] += 1
    ranked = sorted(counts.items(), key=lambda kv: kv[1])
    return {s for s, _ in ranked[:4]}


def under_represented_genres(lessons: list[dict]) -> set[str]:
    """Genre clusters with <=3 lessons currently."""
    counts: dict[str, int] = {}
    for l in lessons:
        g = (l.get('album', {}).get('genre') or '').lower()
        cluster = None
        for needle, name in GENRE_CLUSTERS.items():
            if needle in g:
                cluster = name
                break
        cluster = cluster or 'other'
        counts[cluster] = counts.get(cluster, 0) + 1
    return {g for g, c in counts.items() if c <= 3 and g in GENRE_CLUSTERS.values()}


# ---------------------------------------------------------------------------
# Plex
# ---------------------------------------------------------------------------

class PlexClient:
    """Minimal Plex client. Uses XML endpoints (Plex's stable contract).

    Exposes:
      - find_music_section() -> section id (string) or None
      - search_track(section_id, candidate) -> match dict or None
    """

    def __init__(self, base_url: str, token: str, verbose: bool = False):
        self.base_url = base_url.rstrip('/')
        self.token = token
        self.verbose = verbose
        self.section_id: str | None = None
        self._artist_cache: dict[str, list[dict]] = {}
        self.unreachable = False

    def _get(self, path: str, params: dict | None = None,
             timeout: float = 8.0) -> ET.Element | None:
        if self.unreachable:
            return None
        q = dict(params or {})
        q['X-Plex-Token'] = self.token
        url = f'{self.base_url}{path}?{urllib.parse.urlencode(q)}'
        req = urllib.request.Request(url, headers={'Accept': 'application/xml'})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = resp.read()
            return ET.fromstring(data)
        except (urllib.error.URLError, urllib.error.HTTPError, ET.ParseError,
                TimeoutError, ConnectionError, OSError) as e:
            vlog(self.verbose, f'    [Plex] {path} failed: {e!r}')
            # First failure marks Plex unreachable so we don't keep hammering
            self.unreachable = True
            return None

    def find_music_section(self) -> str | None:
        if self.section_id:
            return self.section_id
        root = self._get('/library/sections')
        if root is None:
            return None
        for d in root.iter('Directory'):
            if d.attrib.get('type') == 'artist':
                self.section_id = d.attrib.get('key')
                vlog(self.verbose,
                     f'    [Plex] music section "{d.attrib.get("title")}" key={self.section_id}')
                return self.section_id
        return None

    def search_track(self, section_id: str, candidate: dict) -> dict | None:
        """Search for a track that matches both title and artist (fuzzy)."""
        cand_artist_norm = normalize(candidate['artist'])
        cand_track_norm = normalize(candidate['track'])

        # Use track title as Plex query (best for finding the right track).
        query = candidate['track']
        # Strip parenthetical disambiguators that confuse Plex's fuzzy match
        query_clean = re.sub(r'\(.*?\)', '', query).strip() or query
        root = self._get(
            f'/library/sections/{section_id}/search',
            params={'type': 10, 'query': query_clean, 'limit': 12},
        )
        if root is None:
            return None
        for tr in root.iter('Track'):
            t_title = tr.attrib.get('title', '')
            t_artist = (tr.attrib.get('grandparentTitle')
                        or tr.attrib.get('originalTitle') or '')
            t_album = tr.attrib.get('parentTitle', '')
            t_norm = normalize(t_title)
            a_norm = normalize(t_artist)
            # Title match: candidate-norm appears in plex-norm OR vice versa
            title_hit = (cand_track_norm in t_norm) or (t_norm in cand_track_norm)
            # Artist match: substring either way (handles "Eagles" vs "The Eagles")
            artist_hit = (cand_artist_norm in a_norm) or (a_norm in cand_artist_norm) \
                if a_norm else False
            if title_hit and artist_hit:
                return {
                    'ratingKey': tr.attrib.get('ratingKey'),
                    'title': t_title,
                    'artist': t_artist,
                    'album': t_album,
                }
        return None


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

def score_candidate(cand: dict,
                    in_plex: bool,
                    under_skills: set[str],
                    under_genres: set[str],
                    rng: random.Random) -> tuple[int, dict]:
    breakdown: dict[str, int] = {}
    if in_plex:
        breakdown['inPlex'] = 100
    if cand.get('difficulty') == 'advanced':
        breakdown['advanced'] = 20
    if any(s in under_skills for s in cand.get('primarySkills', [])):
        breakdown['underCoveredSkill'] = 15
    if cand.get('genre', '').lower() in under_genres:
        breakdown['underRepresentedGenre'] = 10
    breakdown['tiebreaker'] = rng.randint(0, 5)
    return sum(breakdown.values()), breakdown


# ---------------------------------------------------------------------------
# AI proxy + lesson generation
# ---------------------------------------------------------------------------

# This system prompt is the lesson-writer contract. It mirrors
# js/lesson-generator.js so generated JSON merges directly into hifi-guide.json.
def build_system_prompt() -> str:
    return (
        'You are an expert audiophile educator writing a single lesson for "HiFi Buddy", '
        'a critical-listening tutor.\n\n'
        'Your job: given a track identifier and an audiophile reference note, return a '
        'fully formed lesson in JSON that matches the schema below EXACTLY. Output ONLY '
        'valid JSON. No prose, no markdown fences, no commentary.\n\n'
        'SCHEMA (all keys required unless marked optional):\n'
        '{\n'
        '  "title": string,            // short lesson title, e.g. "Tracking the Bass Line"\n'
        '  "difficulty": "beginner" | "intermediate" | "advanced",\n'
        '  "skills": string[],         // 1-3 skill IDs, drawn from the list below\n'
        '  "album": {\n'
        '    "title": string,\n'
        '    "artist": string,\n'
        '    "year": number,\n'
        '    "label": string,\n'
        '    "format": string,          // 1-3 sentences on the recording / mastering provenance\n'
        '    "masteredBy": string       // optional, "" if unknown\n'
        '  },\n'
        '  "track": {\n'
        '    "title": string,\n'
        '    "duration": "M:SS",        // string, e.g. "4:12" or "8:26"\n'
        '    "versionNote": string      // 1 sentence pinning down WHICH version (album/remaster/edit)\n'
        '  },\n'
        '  "guide": {\n'
        '    "intro": string,           // 2-3 sentences setting up what this track teaches\n'
        '    "listenFor": [             // 4-6 entries, ordered by timestamp\n'
        '      {\n'
        '        "time": "M:SS-M:SS",   // strict format, both ends inclusive, e.g. "0:55-1:15"\n'
        '        "skill": string,       // one of the skill IDs below\n'
        '        "note": string         // 80-120 words, concrete and audiophile-targeted\n'
        '      }\n'
        '    ],\n'
        '    "takeaway": string         // 1-2 sentences distilling what they should walk away with\n'
        '  },\n'
        '  "equipment": {\n'
        '    "source": string,          // recommended source format ("CD/FLAC 16/44.1", "Hi-Res 24/96 vinyl rip", etc.)\n'
        '    "whyItMatters": string     // 1-2 sentences explaining why that source matters here\n'
        '  }\n'
        '}\n\n'
        'VALID SKILL IDs (use only these, lowercase):\n'
        '- soundstage     (perceived spatial width/depth/height)\n'
        '- imaging        (precise instrument placement in the stage)\n'
        '- detail         (micro-details: pick attacks, breaths, room reflections)\n'
        '- dynamics       (macro/micro contrast between loud and quiet)\n'
        '- tonal-color    (timbre - a Strat vs. a Les Paul, a Steinway vs. a Bosendorfer)\n'
        '- bass           (extension, texture, speed, decay, pitch definition)\n'
        '- separation     (distinguishing instruments in dense passages)\n'
        '- transients     (initial sharp onsets - pick, stick, hammer)\n'
        '- air            (sense of room atmosphere and reverb tail)\n'
        '- layering       (front-to-back depth)\n\n'
        'WRITING STYLE:\n'
        '- Audiophile-targeted, concrete, specific. Say "the snare crack at 1:42 lands left of center" '
        'not "drums sound nice".\n'
        '- Each listenFor.note is 80-120 words. Reference exact moments, instruments, mix decisions.\n'
        '- No emojis, no exclamation marks, no marketing language ("amazing", "incredible").\n'
        '- timestamps must be in M:SS-M:SS form (e.g. "0:00-0:15", "5:00-5:40"). Both ends real, '
        'end > start, end <= track duration.\n\n'
        'If you do not know the track or are uncertain about facts (year, label, mastering engineer), '
        'use empty strings for those fields rather than fabricating. Pick listenFor moments based on '
        "the track's structure inferred from the user's identifier. The user will also provide an "
        'audiophileNote that explains WHY this recording is reference-grade — incorporate those '
        'specific engineering, mic-technique, or musical-moment details into the listenFor segments.'
    )


def build_user_prompt(cand: dict) -> str:
    return (
        f"Generate a HiFi Buddy lesson for: {cand['artist']} - {cand['track']} "
        f"(album: {cand['album']}, year: {cand['year']}, genre: {cand['genre']}).\n"
        f"Suggested difficulty: {cand['difficulty']}.\n"
        f"Suggested primary skills (you may adjust if you have a better take): "
        f"{', '.join(cand['primarySkills'])}.\n"
        f"audiophileNote (incorporate the specific engineering/musical detail it surfaces "
        f"into your listenFor segments): {cand['audiophileNote']}\n\n"
        f"Return JSON only."
    )


def call_ai(backend: str, system_prompt: str, user_prompt: str,
            *, hifi_server: str, claude_key: str | None,
            ollama_url: str | None, ollama_model: str | None,
            timeout: float = 120.0) -> str:
    """Returns the raw model text (post-extraction from proxy envelope)."""
    if backend == 'claude':
        if not claude_key:
            raise RuntimeError('Claude backend requested but no API key.')
        body = {
            'apiKey': claude_key,
            'model': 'claude-sonnet-4-6',
            'max_tokens': 2048,
            'system': system_prompt,
            'messages': [{'role': 'user', 'content': user_prompt}],
        }
        url = f'{hifi_server.rstrip("/")}/api/claude'
    elif backend == 'ollama':
        if not ollama_url:
            raise RuntimeError('Ollama backend requested but no URL.')
        body = {
            'ollamaUrl': ollama_url,
            'model': ollama_model or 'gemma2:9b',
            'system': system_prompt,
            'messages': [{'role': 'user', 'content': user_prompt}],
            'format': 'json',
        }
        url = f'{hifi_server.rstrip("/")}/api/ollama'
    else:
        raise RuntimeError(f'Unknown backend: {backend}')

    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode('utf-8'),
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode('utf-8'))
    # Extract text — the HiFi Buddy proxy passes through the upstream envelope.
    if isinstance(data, dict):
        # Claude: { content: [{type:"text", text:"..."}], ... }
        content = data.get('content')
        if isinstance(content, list) and content and isinstance(content[0], dict):
            t = content[0].get('text')
            if t:
                return t
        # Ollama chat: { message: { content: "..." }, ... }
        msg = data.get('message')
        if isinstance(msg, dict):
            mc = msg.get('content')
            if mc:
                return mc
        # Ollama generate fallback
        if 'response' in data and data['response']:
            return data['response']
    return ''


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def extract_json(text: str) -> Any | None:
    if not text:
        return None
    s = text.strip()
    s = re.sub(r'^```(?:json)?\s*', '', s, flags=re.IGNORECASE)
    s = re.sub(r'\s*```\s*$', '', s)
    first = s.find('{')
    last = s.rfind('}')
    if first < 0 or last <= first:
        return None
    try:
        return json.loads(s[first:last + 1])
    except json.JSONDecodeError:
        return None


def validate_lesson(obj: Any) -> tuple[bool, str, dict | None]:
    """Returns (ok, error_message, normalized_lesson_or_None)."""
    if not isinstance(obj, dict):
        return False, 'Response is not a JSON object.', None
    errs: list[str] = []

    if not isinstance(obj.get('title'), str) or not obj['title']:
        errs.append('Missing or non-string `title`.')
    if obj.get('difficulty') not in VALID_DIFFICULTIES:
        errs.append(f'`difficulty` must be one of: {", ".join(VALID_DIFFICULTIES)}.')

    skills = obj.get('skills')
    if not isinstance(skills, list) or not (1 <= len(skills) <= 3):
        errs.append('`skills` must be an array of 1-3 skill IDs.')
    else:
        bad = [s for s in skills if s not in VALID_SKILLS]
        if bad:
            errs.append(f'Unknown skill IDs: {bad}. Valid: {VALID_SKILLS}.')

    album = obj.get('album')
    if not isinstance(album, dict):
        errs.append('Missing `album` object.')
    else:
        for k in ('title', 'artist', 'label', 'format'):
            if not isinstance(album.get(k), str):
                errs.append(f'album.{k} must be a string.')
        if not isinstance(album.get('year'), (int, float)):
            errs.append('album.year must be a number.')

    track = obj.get('track')
    track_secs: float = float('inf')
    if not isinstance(track, dict):
        errs.append('Missing `track` object.')
    else:
        if not isinstance(track.get('title'), str):
            errs.append('track.title must be a string.')
        if not TIME_RE.match(str(track.get('duration', ''))):
            errs.append('track.duration must match M:SS format, e.g. "4:12".')
        else:
            track_secs = parse_secs(track['duration'])

    guide = obj.get('guide')
    if not isinstance(guide, dict):
        errs.append('Missing `guide` object.')
    else:
        if not isinstance(guide.get('intro'), str):
            errs.append('guide.intro must be a string.')
        if not isinstance(guide.get('takeaway'), str):
            errs.append('guide.takeaway must be a string.')
        listen_for = guide.get('listenFor')
        if not isinstance(listen_for, list) or len(listen_for) < 3:
            errs.append('guide.listenFor must be an array of at least 3 segments.')
        else:
            for i, seg in enumerate(listen_for):
                if not isinstance(seg, dict):
                    errs.append(f'listenFor[{i}] is not an object.')
                    continue
                m = RANGE_RE.match(str(seg.get('time', '')))
                if not m:
                    errs.append(
                        f'listenFor[{i}].time must match M:SS-M:SS, got "{seg.get("time")}".')
                else:
                    start = int(m.group(1)) * 60 + int(m.group(2))
                    end = int(m.group(3)) * 60 + int(m.group(4))
                    if end <= start:
                        errs.append(
                            f'listenFor[{i}].time end must be greater than start.')
                    if end > track_secs + 1:
                        errs.append(
                            f'listenFor[{i}].time exceeds track duration.')
                if seg.get('skill') not in VALID_SKILLS:
                    errs.append(
                        f'listenFor[{i}].skill "{seg.get("skill")}" not a valid skill ID.')
                note = seg.get('note')
                if not isinstance(note, str) or len(note.strip()) < 40:
                    errs.append(
                        f'listenFor[{i}].note must be a substantive string (>= 40 chars).')

    eq = obj.get('equipment')
    if not isinstance(eq, dict):
        errs.append('Missing `equipment` object.')
    else:
        if not isinstance(eq.get('source'), str):
            errs.append('equipment.source must be a string.')
        if not isinstance(eq.get('whyItMatters'), str):
            errs.append('equipment.whyItMatters must be a string.')

    if errs:
        return False, ' '.join(errs), None

    # Normalize into canonical lesson shape (mirrors lesson-generator.js).
    lesson = {
        'title': obj['title'],
        'difficulty': obj['difficulty'],
        'skills': list(obj['skills'])[:3],
        'album': {
            'title': obj['album']['title'],
            'artist': obj['album']['artist'],
            'year': obj['album']['year'],
            'label': obj['album']['label'],
            'format': obj['album']['format'],
            'masteredBy': obj['album'].get('masteredBy', '') or '',
        },
        'track': {
            'title': obj['track']['title'],
            'duration': obj['track']['duration'],
            'versionNote': obj['track'].get('versionNote', '') or '',
        },
        'guide': {
            'intro': obj['guide']['intro'],
            'listenFor': [
                {'time': s['time'], 'skill': s['skill'], 'note': s['note']}
                for s in obj['guide']['listenFor']
            ],
            'takeaway': obj['guide']['takeaway'],
        },
        'equipment': {
            'source': obj['equipment']['source'],
            'whyItMatters': obj['equipment']['whyItMatters'],
        },
    }
    return True, '', lesson


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description='Propose new HiFi Buddy lessons by intersecting the '
                    'audiophile reference catalog with the user\'s Plex library '
                    'and (optionally) drafting lessons via the HiFi Buddy AI proxy.',
    )
    p.add_argument('--plex-url', default=os.environ.get('PLEX_URL'),
                   help='Plex server URL (or env PLEX_URL).')
    p.add_argument('--plex-token', default=os.environ.get('PLEX_TOKEN'),
                   help='Plex token (or env PLEX_TOKEN).')
    p.add_argument('--ai', choices=('claude', 'ollama', 'none'), default=None,
                   help='AI backend. "none" disables lesson drafting.')
    p.add_argument('--claude-key', default=os.environ.get('CLAUDE_API_KEY'),
                   help='Anthropic API key (or env CLAUDE_API_KEY).')
    p.add_argument('--ollama-url',
                   default=os.environ.get('OLLAMA_URL', 'http://localhost:11434'),
                   help='Ollama URL (default http://localhost:11434, or env OLLAMA_URL).')
    p.add_argument('--ollama-model',
                   default=os.environ.get('OLLAMA_MODEL', 'gemma2:9b'),
                   help='Ollama model (default gemma2:9b, or env OLLAMA_MODEL).')
    p.add_argument('--hifi-server', default='http://127.0.0.1:8090',
                   help='Running HiFi Buddy server (default http://127.0.0.1:8090).')
    p.add_argument('--top', type=int, default=12,
                   help='How many candidates to draft lessons for (default 12).')
    p.add_argument('--output', default=os.path.join(REPO_ROOT, 'proposed-lessons.json'),
                   help='Output file (default proposed-lessons.json).')
    p.add_argument('--verbose', action='store_true',
                   help='Show progress per track.')
    p.add_argument('--seed', type=int, default=None,
                   help='RNG seed for the score tiebreaker (test reproducibility).')
    return p.parse_args()


def prompt_if_missing(args: argparse.Namespace) -> None:
    """Prompt interactively for Plex creds and AI choice when missing."""
    # AI backend
    if args.ai is None:
        try:
            choice = input(
                'AI backend? [c]laude / [o]llama / [n]one (default n): '
            ).strip().lower()
        except EOFError:
            choice = 'n'
        if choice.startswith('c'):
            args.ai = 'claude'
        elif choice.startswith('o'):
            args.ai = 'ollama'
        else:
            args.ai = 'none'

    if args.ai == 'claude' and not args.claude_key:
        try:
            args.claude_key = getpass.getpass('Anthropic API key: ').strip() or None
        except EOFError:
            args.claude_key = None
        if not args.claude_key:
            print('No Claude key provided; switching --ai to none.', file=sys.stderr)
            args.ai = 'none'

    # Plex
    if not args.plex_url:
        try:
            args.plex_url = input(
                'Plex URL (e.g. http://localhost:32400, blank to skip): '
            ).strip() or None
        except EOFError:
            args.plex_url = None
    if args.plex_url and not args.plex_token:
        try:
            args.plex_token = getpass.getpass('Plex token: ').strip() or None
        except EOFError:
            args.plex_token = None


def run_plex_pass(plex: PlexClient | None, candidates: list[dict],
                  verbose: bool) -> dict[str, dict | None]:
    """Returns {candidate_id: plex_match_or_None}."""
    matches: dict[str, dict | None] = {c['id']: None for c in candidates}
    if plex is None:
        return matches

    section_id = plex.find_music_section()
    if not section_id:
        print('  [Plex] could not find music section; treating all as not-in-Plex',
              file=sys.stderr)
        return matches

    for i, cand in enumerate(candidates, 1):
        if plex.unreachable:
            break
        m = plex.search_track(section_id, cand)
        matches[cand['id']] = m
        flag = 'in Plex' if m else 'not in Plex'
        vlog(verbose,
             f'  [{i:>3}/{len(candidates)}] {cand["artist"]} - {cand["track"]} ... {flag}')
        # be polite to Plex
        time.sleep(0.05)

    if plex.unreachable:
        print('  [Plex] became unreachable mid-scan; remaining tracks treated as not-in-Plex',
              file=sys.stderr)

    found = sum(1 for v in matches.values() if v)
    print(f'  [Plex complete] {found} of {len(candidates)} in library')
    return matches


def generate_lessons(top_candidates: list[dict], score_data: dict,
                     plex_matches: dict[str, dict | None],
                     args: argparse.Namespace) -> list[dict]:
    """Generate lesson drafts for the top-N candidates. Returns lesson records."""
    sys_prompt = build_system_prompt()
    out: list[dict] = []

    for idx, cand in enumerate(top_candidates, 1):
        rec = {
            'candidateId': cand['id'],
            'status': 'ok',
            'score': score_data[cand['id']]['score'],
            'scoreBreakdown': score_data[cand['id']]['breakdown'],
            'plexMatch': plex_matches.get(cand['id']),
            'lesson': None,
            'errors': [],
        }
        out.append(rec)

        if args.ai == 'none':
            rec['status'] = 'needs_review'
            rec['errors'].append('AI generation disabled (--ai=none).')
            vlog(args.verbose,
                 f'  [AI generation {idx}/{len(top_candidates)}] '
                 f'{cand["artist"]} - {cand["track"]} ... skipped (--ai=none)')
            continue

        user_prompt = build_user_prompt(cand)
        last_err = ''
        last_raw = ''
        try:
            raw = call_ai(
                args.ai, sys_prompt, user_prompt,
                hifi_server=args.hifi_server,
                claude_key=args.claude_key,
                ollama_url=args.ollama_url,
                ollama_model=args.ollama_model,
            )
            last_raw = raw
            parsed = extract_json(raw)
            ok, err, lesson = validate_lesson(parsed)

            if not ok:
                last_err = err
                # Retry once with the error fed back to the model
                retry_prompt = (
                    f'{user_prompt}\n\n'
                    f'Your previous response did not validate. Errors: {err}\n'
                    f'Return ONLY corrected JSON.'
                )
                raw = call_ai(
                    args.ai, sys_prompt, retry_prompt,
                    hifi_server=args.hifi_server,
                    claude_key=args.claude_key,
                    ollama_url=args.ollama_url,
                    ollama_model=args.ollama_model,
                )
                last_raw = raw
                parsed = extract_json(raw)
                ok, err, lesson = validate_lesson(parsed)
                last_err = err

            if ok:
                rec['lesson'] = lesson
                vlog(args.verbose,
                     f'  [AI generation {idx}/{len(top_candidates)}] '
                     f'{cand["artist"]} - {cand["track"]} ... OK')
            else:
                rec['status'] = 'needs_review'
                rec['errors'].append(f'Validation failed: {last_err}')
                rec['rawAiResponse'] = last_raw
                vlog(args.verbose,
                     f'  [AI generation {idx}/{len(top_candidates)}] '
                     f'{cand["artist"]} - {cand["track"]} ... validation failed: {last_err[:120]}')
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError,
                ConnectionError, OSError, RuntimeError) as e:
            rec['status'] = 'ai_failed'
            rec['errors'].append(f'AI proxy error: {e!r}')
            if last_raw:
                rec['rawAiResponse'] = last_raw
            vlog(args.verbose,
                 f'  [AI generation {idx}/{len(top_candidates)}] '
                 f'{cand["artist"]} - {cand["track"]} ... proxy error: {e!r}')

    return out


def main() -> int:
    args = parse_args()
    prompt_if_missing(args)
    rng = random.Random(args.seed)

    # 1. Load existing lessons + catalog, build exclusion, filter
    try:
        lessons = load_existing_lessons()
        catalog = load_catalog()
    except (OSError, json.JSONDecodeError) as e:
        print(f'ERROR: could not load reference data: {e}', file=sys.stderr)
        return 2

    excl = build_exclusion_set(lessons)
    candidates = filter_candidates(catalog, excl)
    print(f'Loaded {len(catalog)} catalog entries; '
          f'{len(catalog) - len(candidates)} duplicate existing lessons; '
          f'{len(candidates)} candidates remain.')

    under_skills = under_covered_skills(lessons)
    under_genres = under_represented_genres(lessons)
    print(f'Under-covered skills (per-segment, bottom 4): {sorted(under_skills)}')
    print(f'Under-represented genre clusters: {sorted(under_genres)}')

    # 2. Plex pass
    plex: PlexClient | None = None
    if args.plex_url and args.plex_token:
        plex = PlexClient(args.plex_url, args.plex_token, verbose=args.verbose)
        print(f'Querying Plex at {args.plex_url} ...')
    else:
        print('Plex not configured (no URL/token); skipping library intersection.')

    plex_matches = run_plex_pass(plex, candidates, args.verbose)

    # 3. Score
    score_data: dict[str, dict] = {}
    for cand in candidates:
        in_plex = plex_matches.get(cand['id']) is not None
        s, breakdown = score_candidate(cand, in_plex, under_skills, under_genres, rng)
        score_data[cand['id']] = {'score': s, 'breakdown': breakdown}

    # 4. Pick top N (prefer in-Plex, then score)
    sorted_cands = sorted(
        candidates,
        key=lambda c: (
            -1 if plex_matches.get(c['id']) else 0,  # in-Plex first
            -score_data[c['id']]['score'],
        ),
    )
    in_plex_count = sum(1 for c in candidates if plex_matches.get(c['id']))

    # If Plex returned nothing, still process top scores (for catalog-only mode)
    # but ONLY if AI is on AND --top > 0. With --ai=none and no Plex, output empty
    # lesson list (per spec: "graceful failure").
    if args.ai == 'none' and in_plex_count == 0:
        top = []
    else:
        top = sorted_cands[:max(0, args.top)]

    # 5. Generate
    lesson_records = generate_lessons(top, score_data, plex_matches, args)

    # 6. Write output
    output = {
        'generatedAt': now_iso(),
        'totalCandidates': len(candidates),
        'inPlex': in_plex_count,
        'selected': len(lesson_records),
        'lessons': lesson_records,
    }
    try:
        with open(args.output, 'w', encoding='utf-8') as f:
            json.dump(output, f, indent=2, ensure_ascii=False)
    except OSError as e:
        print(f'ERROR: could not write {args.output}: {e}', file=sys.stderr)
        return 2

    # 7. Summary
    n_ok = sum(1 for r in lesson_records if r['status'] == 'ok')
    n_review = sum(1 for r in lesson_records if r['status'] == 'needs_review')
    n_failed = sum(1 for r in lesson_records if r['status'] == 'ai_failed')
    print(
        f'Wrote {args.output}: '
        f'{len(lesson_records)} lessons '
        f'({n_ok} ok, {n_review} needs_review, {n_failed} ai_failed)'
    )
    return 0


if __name__ == '__main__':
    sys.exit(main())
