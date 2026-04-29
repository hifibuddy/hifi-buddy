# tools/

Stdlib-only Python helpers that catch silently-broken data files and
JS/Python syntax errors before they reach users. Run these locally before
pushing; CI runs them on every push and PR.

All-in-one:

```
make test
```

That runs `validate`, `lint`, then `node -c` on every file in `js/` and
`py_compile` on `server.py` and `propose_lessons.py`. Prints
`All tests passed.` on success.

---

## validate_data.py

Schema-validates the four canonical data files against inline schemas:

- `data/hifi-guide.json` (skills + lessons)
- `data/reference-clips.json`
- `data/reference-catalog.json`
- `data/headphones-fr.json`

Checks types, required keys, enum values (difficulty, headphone type),
canonical skill IDs, M:SS / M:SS-M:SS time formats, and FR-curve point
counts.

```
python3 tools/validate_data.py                  # all four files
python3 tools/validate_data.py data/hifi-guide.json  # one file
make validate
```

Exit codes: `0` if every file passed, `1` if any file failed.

When to run: anytime you hand-edit a data file or after a generator
script (`propose_lessons.py`, `apply_*.py`) writes new data.

## lint_lessons.py

Higher-level cross-field sanity checks on `data/hifi-guide.json` that
the schema validator can't express:

- `listenFor[].time` segments end at or before `track.duration`
- Segments are in chronological order (overlap allowed, no time-travel)
- Top-level `lesson.skills` is a superset of skills used in `listenFor`
- `track.musicbrainzRecordingId` matches MBID format if present
- `abx.segment` (when not skipped) matches one of the `listenFor` time
  strings
- Lessons whose track is an `audiophilePressing` have `abx.skip: true`

```
python3 tools/lint_lessons.py
make lint
```

Exit codes: `0` if every lesson is clean, `1` if any warnings.

When to run: after generating or editing lessons. CI runs this on every
push.

---

## CI

`.github/workflows/ci.yml` runs three jobs on push to `main` and on every
PR: `syntax` (Node `node -c` + Python `py_compile`), `data`
(`validate_data.py` + `lint_lessons.py`), and `json-format` (every JSON
file in `data/` plus `manifest.json` parses).
