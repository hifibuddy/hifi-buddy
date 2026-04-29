/**
 * HiFi Buddy Lesson Generator (Unified)
 *
 * One modal, four input modes:
 *   A. Quick guide   — fill out artist / track / album / duration / focus skill
 *   B. Paste track   — paste "Artist - Title", a Spotify URL, or a Plex track ID
 *   C. Browse Plex   — pick a curated reference track that exists in your Plex
 *                      library (intersection of data/reference-catalog.json with
 *                      your library, cached in localStorage)
 *   D. Import pack   — load a `proposed-lessons.json` produced by
 *                      propose_lessons.py and import selected lessons in bulk
 *
 * All four modes funnel into the same review UI: preview the generated lesson,
 * then either Save (persist to localStorage.hifibuddy_user_lessons) or Discard.
 *
 * Public API:
 *   open()                  — show the generator modal
 *   generate(input, opts?)  — async; returns parsed+validated lesson object
 *   listUserLessons()       — array of lessons stored locally
 *   deleteUserLesson(id)    — remove a generated lesson
 */
window.HiFiBuddyLessonGenerator = (() => {
    'use strict';

    const STORAGE_KEY = 'hifibuddy_user_lessons';
    const PLEX_SCAN_CACHE_KEY = 'hifibuddy_browseplex_matches';

    const VALID_SKILLS = [
        'soundstage', 'imaging', 'detail', 'dynamics', 'tonal-color',
        'bass', 'separation', 'transients', 'air', 'layering',
    ];
    const VALID_DIFFICULTIES = ['beginner', 'intermediate', 'advanced'];

    // Skill display metadata (used by the Quick guide focus dropdown)
    const SKILL_LABELS = {
        'soundstage':   'Soundstage',
        'imaging':      'Imaging',
        'detail':       'Detail',
        'dynamics':     'Dynamics',
        'tonal-color':  'Tonal Color',
        'bass':         'Bass',
        'separation':   'Separation',
        'transients':   'Transients',
        'air':          'Air',
        'layering':     'Layering',
    };

    // Module-level UI state — reset every time the modal opens
    let activeTab = 'quick';
    let pendingLesson = null;       // lesson object awaiting review/save
    let plexScanState = null;       // { status, scanned, total, matched, results }
    let importPackState = null;     // { fileName, lessons: [...] }

    // ===== Storage =====

    function listUserLessons() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch { return []; }
    }

    function saveUserLesson(lesson) {
        const all = listUserLessons();
        const idx = all.findIndex(l => l.id === lesson.id);
        if (idx >= 0) all[idx] = lesson; else all.unshift(lesson);
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(all)); }
        catch (e) { console.warn('[LessonGen] save failed:', e); }
    }

    function deleteUserLesson(id) {
        if (!id) return;
        const all = listUserLessons().filter(l => l.id !== id);
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(all)); }
        catch (e) { console.warn('[LessonGen] delete failed:', e); }
    }

    // ===== Prompt =====

    // System prompt for the lesson-writer model. We deliberately spell out
    // the schema (instead of relying on the model to recall it from training)
    // and constrain skill IDs / time format / word budget so the parser has
    // a fighting chance.
    function buildSystemPrompt() {
        return `You are an expert audiophile educator writing a single lesson for "HiFi Buddy", a critical-listening tutor.

Your job: given a track identifier, return a fully formed lesson in JSON that matches the schema below EXACTLY. Output ONLY valid JSON. No prose, no markdown fences, no commentary.

SCHEMA (all keys required unless marked optional):
{
  "title": string,            // short lesson title, e.g. "Tracking the Bass Line"
  "difficulty": "beginner" | "intermediate" | "advanced",
  "skills": string[],         // 1-3 skill IDs, drawn from the list below
  "album": {
    "title": string,
    "artist": string,
    "year": number,
    "label": string,
    "format": string,          // 1-3 sentences on the recording / mastering provenance
    "masteredBy": string       // optional, "" if unknown
  },
  "track": {
    "title": string,
    "duration": "M:SS",        // string, e.g. "4:12" or "8:26"
    "versionNote": string      // 1 sentence pinning down WHICH version (album/remaster/edit)
  },
  "guide": {
    "intro": string,           // 2-3 sentences setting up what this track teaches
    "listenFor": [             // 4-6 entries, ordered by timestamp
      {
        "time": "M:SS-M:SS",   // strict format, both ends inclusive, e.g. "0:55-1:15"
        "skill": string,       // one of the skill IDs below
        "note": string         // 80-120 words, concrete and audiophile-targeted
      }
    ],
    "takeaway": string         // 1-2 sentences distilling what they should walk away with
  },
  "equipment": {
    "source": string,          // recommended source format ("CD/FLAC 16/44.1", "Hi-Res 24/96 vinyl rip", etc.)
    "whyItMatters": string     // 1-2 sentences explaining why that source matters here
  }
}

VALID SKILL IDs (use only these, lowercase):
- soundstage     (perceived spatial width/depth/height)
- imaging        (precise instrument placement in the stage)
- detail         (micro-details: pick attacks, breaths, room reflections)
- dynamics       (macro/micro contrast between loud and quiet)
- tonal-color    (timbre — a Strat vs. a Les Paul, a Steinway vs. a Bosendorfer)
- bass           (extension, texture, speed, decay, pitch definition)
- separation     (distinguishing instruments in dense passages)
- transients     (initial sharp onsets — pick, stick, hammer)
- air            (sense of room atmosphere and reverb tail)
- layering       (front-to-back depth)

WRITING STYLE:
- Audiophile-targeted, concrete, specific. Say "the snare crack at 1:42 lands left of center" not "drums sound nice".
- Each listenFor.note is 80-120 words. Reference exact moments, instruments, mix decisions.
- No emojis, no exclamation marks, no marketing language ("amazing", "incredible").
- timestamps must be in M:SS-M:SS form (e.g. "0:00-0:15", "5:00-5:40"). Both ends real, end > start, end <= track duration.

If you do not know the track or are uncertain about facts (year, label, mastering engineer), use empty strings for those fields rather than fabricating. Pick listenFor moments based on the track's structure inferred from the user's identifier.`;
    }

    function buildUserPrompt(input, opts) {
        // opts: { focusSkill?, durationHint?, albumHint? }
        let prompt = `Generate a HiFi Buddy lesson for: ${input}`;
        if (opts?.focusSkill) {
            prompt += `\n\nFocus the lesson on the "${opts.focusSkill}" skill — make at least half of the listenFor moments tag this skill.`;
        }
        if (opts?.durationHint) {
            prompt += `\n\nTrack duration: ${opts.durationHint}. Keep all listenFor timestamps within this range.`;
        }
        if (opts?.albumHint) {
            prompt += `\n\nAlbum context: ${opts.albumHint}.`;
        }
        prompt += `\n\nReturn JSON only.`;
        return prompt;
    }

    // ===== AI call =====

    async function callAI(systemPrompt, userPrompt) {
        const ollamaUrl = localStorage.getItem('hifibuddy_ollama_url') || '';
        const ollamaModel = localStorage.getItem('hifibuddy_ollama_model') || 'gemma2:9b';
        const claudeKey = typeof HiFiBuddySettings !== 'undefined'
            ? HiFiBuddySettings.getClaudeApiKey?.() : '';

        const messages = [{ role: 'user', content: userPrompt }];

        let res, data;
        if (claudeKey) {
            try {
                res = await fetch('/api/claude', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        apiKey: claudeKey,
                        model: 'claude-sonnet-4-6',
                        max_tokens: 2048,
                        system: systemPrompt,
                        messages,
                    }),
                });
            } catch (e) {
                throw new Error(`Claude API unreachable: ${e?.message || e}`);
            }
        } else if (ollamaUrl) {
            try {
                res = await fetch('/api/ollama', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        ollamaUrl, model: ollamaModel,
                        system: systemPrompt, messages,
                        format: 'json',  // Ollama strict-JSON mode — small models need this
                    }),
                });
            } catch (e) {
                throw new Error(`Ollama unreachable at ${ollamaUrl}: ${e?.message || e}`);
            }
        } else {
            throw new Error('No AI backend configured. Set up Claude or Ollama in Settings.');
        }
        if (!res.ok) {
            // Capture the actual response body so the caller can show it.
            let bodyText = '';
            try { bodyText = (await res.text()).slice(0, 800); } catch { /* ignore */ }
            const which = claudeKey ? 'Claude' : 'Ollama';
            throw new Error(`${which} returned ${res.status}. ${bodyText || 'No body in response.'}`);
        }
        data = await res.json();
        // Handle both backends:
        //   Claude: { content: [{type: "text", text: "..."}], ... }
        //   Ollama: { message: { role: "assistant", content: "..." }, ... }
        return data.content?.[0]?.text
            || data.message?.content
            || data.response  // Ollama /api/generate fallback
            || '';
    }

    // ===== Parsing & validation =====

    // Strip markdown fences and extract the first JSON object found in the
    // response. Tolerant of models that wrap JSON in ```json ... ``` or add
    // a sentence of preamble.
    function extractJson(text) {
        if (!text) return null;
        let s = String(text).trim();
        // Strip code fences
        s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
        // Find first { ... last }
        const first = s.indexOf('{');
        const last = s.lastIndexOf('}');
        if (first < 0 || last <= first) return null;
        const slice = s.slice(first, last + 1);
        try { return JSON.parse(slice); }
        catch { return null; }
    }

    const TIME_RE = /^(\d+):([0-5]\d)$/;
    const RANGE_RE = /^(\d+):([0-5]\d)-(\d+):([0-5]\d)$/;

    function parseSecs(t) {
        const m = TIME_RE.exec(t);
        return m ? (+m[1]) * 60 + (+m[2]) : NaN;
    }

    // Validate a parsed lesson candidate. Returns { ok: true, lesson } or
    // { ok: false, error } where `error` is human-readable AND model-readable
    // — we feed it back to the model on retry.
    function validateLesson(obj) {
        if (!obj || typeof obj !== 'object') {
            return { ok: false, error: 'Response is not a JSON object.' };
        }
        const errs = [];

        if (!obj.title || typeof obj.title !== 'string') errs.push('Missing or non-string `title`.');
        if (!VALID_DIFFICULTIES.includes(obj.difficulty)) {
            errs.push(`\`difficulty\` must be one of: ${VALID_DIFFICULTIES.join(', ')}.`);
        }
        if (!Array.isArray(obj.skills) || obj.skills.length < 1 || obj.skills.length > 3) {
            errs.push('`skills` must be an array of 1-3 skill IDs.');
        } else {
            const bad = obj.skills.filter(s => !VALID_SKILLS.includes(s));
            if (bad.length) errs.push(`Unknown skill IDs: ${bad.join(', ')}. Valid: ${VALID_SKILLS.join(', ')}.`);
        }
        if (!obj.album || typeof obj.album !== 'object') {
            errs.push('Missing `album` object.');
        } else {
            ['title', 'artist', 'label', 'format'].forEach(k => {
                if (typeof obj.album[k] !== 'string') errs.push(`album.${k} must be a string.`);
            });
            if (typeof obj.album.year !== 'number' || !isFinite(obj.album.year)) {
                errs.push('album.year must be a number.');
            }
        }
        if (!obj.track || typeof obj.track !== 'object') {
            errs.push('Missing `track` object.');
        } else {
            if (typeof obj.track.title !== 'string') errs.push('track.title must be a string.');
            if (!TIME_RE.test(String(obj.track.duration || ''))) {
                errs.push('track.duration must match M:SS format, e.g. "4:12".');
            }
        }

        let trackSecs = Infinity;
        if (obj.track && TIME_RE.test(String(obj.track.duration || ''))) {
            trackSecs = parseSecs(obj.track.duration);
        }

        if (!obj.guide || typeof obj.guide !== 'object') {
            errs.push('Missing `guide` object.');
        } else {
            if (typeof obj.guide.intro !== 'string') errs.push('guide.intro must be a string.');
            if (typeof obj.guide.takeaway !== 'string') errs.push('guide.takeaway must be a string.');
            if (!Array.isArray(obj.guide.listenFor) || obj.guide.listenFor.length < 3) {
                errs.push('guide.listenFor must be an array of at least 3 segments.');
            } else {
                obj.guide.listenFor.forEach((seg, i) => {
                    if (!seg || typeof seg !== 'object') {
                        errs.push(`listenFor[${i}] is not an object.`);
                        return;
                    }
                    const m = RANGE_RE.exec(String(seg.time || ''));
                    if (!m) {
                        errs.push(`listenFor[${i}].time must match M:SS-M:SS, got "${seg.time}".`);
                    } else {
                        const start = (+m[1]) * 60 + (+m[2]);
                        const end = (+m[3]) * 60 + (+m[4]);
                        if (end <= start) errs.push(`listenFor[${i}].time end must be greater than start.`);
                        if (end > trackSecs + 1) errs.push(`listenFor[${i}].time exceeds track duration.`);
                    }
                    if (!VALID_SKILLS.includes(seg.skill)) {
                        errs.push(`listenFor[${i}].skill "${seg.skill}" not a valid skill ID.`);
                    }
                    if (typeof seg.note !== 'string' || seg.note.trim().length < 40) {
                        errs.push(`listenFor[${i}].note must be a substantive string (>= 40 chars).`);
                    }
                });
            }
        }
        if (!obj.equipment || typeof obj.equipment !== 'object') {
            errs.push('Missing `equipment` object.');
        } else {
            if (typeof obj.equipment.source !== 'string') errs.push('equipment.source must be a string.');
            if (typeof obj.equipment.whyItMatters !== 'string') errs.push('equipment.whyItMatters must be a string.');
        }

        if (errs.length) return { ok: false, error: errs.join(' ') };

        // Normalize into the canonical lesson shape (id assigned at save time)
        const lesson = {
            id: null, // filled in by saveLesson()
            title: obj.title,
            difficulty: obj.difficulty,
            skills: obj.skills.slice(0, 3),
            album: {
                title: obj.album.title,
                artist: obj.album.artist,
                year: obj.album.year,
                label: obj.album.label,
                format: obj.album.format,
                masteredBy: obj.album.masteredBy || '',
            },
            track: {
                title: obj.track.title,
                duration: obj.track.duration,
                versionNote: obj.track.versionNote || '',
            },
            guide: {
                intro: obj.guide.intro,
                listenFor: obj.guide.listenFor.map(s => ({
                    time: s.time,
                    skill: s.skill,
                    note: s.note,
                })),
                takeaway: obj.guide.takeaway,
            },
            equipment: {
                source: obj.equipment.source,
                whyItMatters: obj.equipment.whyItMatters,
            },
            generated: true,
            generatedAt: Date.now(),
        };
        return { ok: true, lesson };
    }

    function newLessonId() {
        return 'usergen-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    }

    // ===== Generate (with one retry) — returns lesson object, does NOT save =====

    async function generate(input, opts) {
        const trimmed = String(input || '').trim();
        if (!trimmed) throw new Error('Please provide a track identifier.');

        const sys = buildSystemPrompt();
        const userPrompt = buildUserPrompt(trimmed, opts || {});

        let raw = await callAI(sys, userPrompt);
        let parsed = extractJson(raw);
        let v = validateLesson(parsed);
        if (v.ok) return v.lesson;

        // Retry once, feeding the error back so the model can self-correct
        const retryPrompt = `${userPrompt}\n\nYour previous response did not validate. Errors: ${v.error}\nReturn ONLY corrected JSON.`;
        const lastRaw = raw;
        raw = await callAI(sys, retryPrompt);
        parsed = extractJson(raw);
        v = validateLesson(parsed);
        if (v.ok) return v.lesson;
        // Carry the raw model output so the UI can show it in a "Copy raw"
        // affordance — this is the single most useful debugging signal when
        // the model returns prose / partial JSON.
        const err = new Error('Validation failed after retry: ' + v.error);
        err.rawResponse = raw || lastRaw || '';
        throw err;
    }

    // ===== HTML helpers =====

    function escHtml(s) {
        const d = document.createElement('div');
        d.textContent = s == null ? '' : String(s);
        return d.innerHTML;
    }

    function ensureModalRoot() {
        let root = document.getElementById('lessonGenOverlay');
        if (root) return root;
        root = document.createElement('div');
        root.id = 'lessonGenOverlay';
        root.className = 'modal-overlay lesson-gen-overlay';
        root.style.display = 'none';
        document.body.appendChild(root);
        return root;
    }

    function closeModal() {
        const root = document.getElementById('lessonGenOverlay');
        if (root) root.style.display = 'none';
    }

    // ===== Modal: top-level chrome and tab strip =====

    function open() {
        // Reset ephemeral state every open
        activeTab = 'quick';
        pendingLesson = null;
        plexScanState = null;
        importPackState = null;

        const root = ensureModalRoot();
        root.style.display = 'flex';
        root.innerHTML = `
            <div class="modal lesson-gen-modal">
                <div class="modal-header">
                    <h3>Add a lesson</h3>
                    <button class="modal-close" id="lgClose" title="Close">
                        ${HiFiBuddyIcons.close({ size: 18 })}
                    </button>
                </div>
                <div class="modal-body">
                    <div class="lg-tabs" role="tablist">
                        <button class="lg-tab" data-tab="quick"  role="tab">Quick guide</button>
                        <button class="lg-tab" data-tab="paste"  role="tab">Paste track</button>
                        <button class="lg-tab" data-tab="plex"   role="tab">Browse Plex</button>
                        <button class="lg-tab" data-tab="import" role="tab">Import pack</button>
                    </div>
                    <div class="lg-tab-body" id="lgTabBody"></div>
                </div>
            </div>
        `;

        root.querySelector('#lgClose')?.addEventListener('click', closeModal);
        root.addEventListener('click', e => { if (e.target === root) closeModal(); });
        root.querySelectorAll('.lg-tab').forEach(btn => {
            btn.addEventListener('click', () => switchTab(btn.dataset.tab));
        });

        switchTab('quick');
    }

    function switchTab(tab) {
        activeTab = tab;
        // Discarding a pending preview when switching tabs avoids
        // confusion ("which tab made this?")
        pendingLesson = null;

        const overlay = document.getElementById('lessonGenOverlay');
        if (!overlay) return;
        overlay.querySelectorAll('.lg-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === tab);
        });

        const body = overlay.querySelector('#lgTabBody');
        if (!body) return;
        if (tab === 'quick')   body.innerHTML = renderQuickTab();
        if (tab === 'paste')   body.innerHTML = renderPasteTab();
        if (tab === 'plex')    body.innerHTML = renderPlexTab();
        if (tab === 'import')  body.innerHTML = renderImportTab();

        if (tab === 'quick')   bindQuickTab();
        if (tab === 'paste')   bindPasteTab();
        if (tab === 'plex')    bindPlexTab();
        if (tab === 'import')  bindImportTab();
    }

    // ===== Tab A: Quick guide =====

    function renderQuickTab() {
        const skillOpts = ['<option value="">All skills (auto-detect)</option>']
            .concat(VALID_SKILLS.map(s => `<option value="${s}">${SKILL_LABELS[s]}</option>`))
            .join('');
        return `
            <p class="lg-help">Fill out the track and the model will compose a full lesson with timestamped listening cues. To save it permanently, click <em>Save</em> after review — otherwise it's just a one-time guide.</p>
            <div class="lg-form-grid">
                <label class="lg-field">
                    <span>Artist</span>
                    <input type="text" id="lgQArtist" class="lg-input" placeholder="e.g. Pink Floyd" />
                </label>
                <label class="lg-field">
                    <span>Track title</span>
                    <input type="text" id="lgQTrack" class="lg-input" placeholder="e.g. Comfortably Numb" />
                </label>
                <label class="lg-field">
                    <span>Album <span class="lg-optional">(optional)</span></span>
                    <input type="text" id="lgQAlbum" class="lg-input" placeholder="e.g. The Wall" />
                </label>
                <label class="lg-field">
                    <span>Duration <span class="lg-optional">(M:SS, optional)</span></span>
                    <input type="text" id="lgQDuration" class="lg-input" placeholder="e.g. 6:24" />
                </label>
                <label class="lg-field lg-field-wide">
                    <span>Focus skill</span>
                    <select id="lgQSkill" class="lg-input">${skillOpts}</select>
                </label>
            </div>
            <div class="lg-actions">
                <button class="lg-generate-btn" id="lgQGenerate">
                    ${HiFiBuddyIcons.spinnerRays({ size: 14 })}
                    Generate
                </button>
            </div>
            <div class="lg-status" id="lgStatus"></div>
            <div class="lg-preview-host" id="lgPreviewHost"></div>
        `;
    }

    function bindQuickTab() {
        const overlay = document.getElementById('lessonGenOverlay');
        overlay?.querySelector('#lgQGenerate')?.addEventListener('click', runQuickGenerate);
        overlay?.querySelectorAll('#lgTabBody .lg-input').forEach(el => {
            if (el.tagName === 'INPUT') {
                el.addEventListener('keydown', e => {
                    if (e.key === 'Enter') runQuickGenerate();
                });
            }
        });
    }

    async function runQuickGenerate() {
        const overlay = document.getElementById('lessonGenOverlay');
        const artist = overlay.querySelector('#lgQArtist')?.value?.trim() || '';
        const track  = overlay.querySelector('#lgQTrack')?.value?.trim() || '';
        const album  = overlay.querySelector('#lgQAlbum')?.value?.trim() || '';
        const dur    = overlay.querySelector('#lgQDuration')?.value?.trim() || '';
        const skill  = overlay.querySelector('#lgQSkill')?.value || '';
        const status = overlay.querySelector('#lgStatus');
        const btn    = overlay.querySelector('#lgQGenerate');

        if (!artist || !track) {
            setStatus(status, 'error', 'Please enter both artist and track title.');
            return;
        }

        const identifier = `${artist} - ${track}`;
        await runGeneration({
            input: identifier,
            opts: { focusSkill: skill || undefined, durationHint: dur || undefined, albumHint: album || undefined },
            statusEl: status, btnEl: btn,
        });
    }

    // ===== Tab B: Paste track =====

    function renderPasteTab() {
        return `
            <p class="lg-help">Paste a Spotify URL, a Plex track ID, or just type "Artist - Track Title". The model will compose a full HiFi Buddy lesson with timestamped listening cues.</p>
            <textarea id="lgPInput" class="lg-input" rows="3"
                placeholder="e.g. Steely Dan - Aja, or https://open.spotify.com/track/..."></textarea>
            <div class="lg-actions">
                <button class="lg-generate-btn" id="lgPGenerate">
                    ${HiFiBuddyIcons.spinnerRays({ size: 14 })}
                    Generate
                </button>
            </div>
            <div class="lg-status" id="lgStatus"></div>
            <div class="lg-preview-host" id="lgPreviewHost"></div>
        `;
    }

    function bindPasteTab() {
        const overlay = document.getElementById('lessonGenOverlay');
        overlay?.querySelector('#lgPGenerate')?.addEventListener('click', runPasteGenerate);
        overlay?.querySelector('#lgPInput')?.addEventListener('keydown', e => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') runPasteGenerate();
        });
    }

    async function runPasteGenerate() {
        const overlay = document.getElementById('lessonGenOverlay');
        const input  = overlay.querySelector('#lgPInput')?.value?.trim() || '';
        const status = overlay.querySelector('#lgStatus');
        const btn    = overlay.querySelector('#lgPGenerate');
        if (!input) {
            setStatus(status, 'error', 'Please enter a track identifier.');
            return;
        }
        await runGeneration({ input, opts: {}, statusEl: status, btnEl: btn });
    }

    // ===== Tab C: Browse Plex =====

    function plexConfigured() {
        return typeof HiFiBuddySettings !== 'undefined'
            && !!HiFiBuddySettings.getPlexUrl?.()
            && !!HiFiBuddySettings.getPlexToken?.();
    }

    function plexUrlHash() {
        if (typeof HiFiBuddySettings === 'undefined') return '';
        const u = HiFiBuddySettings.getPlexUrl?.() || '';
        if (!u) return '';
        let h = 0;
        for (let i = 0; i < u.length; i++) { h = ((h << 5) - h + u.charCodeAt(i)) | 0; }
        return 'pu_' + Math.abs(h).toString(36);
    }

    // Cheap fingerprint of the catalog content. Length-based to avoid scanning
    // 100 entries on every open; if the file changes meaningfully the length
    // changes too in practice.
    function catalogFingerprint(catalog) {
        return `n=${catalog.length}`;
    }

    function loadPlexScanCache() {
        try {
            const raw = localStorage.getItem(PLEX_SCAN_CACHE_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch { return {}; }
    }

    function savePlexScanCache(all) {
        try { localStorage.setItem(PLEX_SCAN_CACHE_KEY, JSON.stringify(all)); }
        catch (e) { console.warn('[LessonGen] cache save failed:', e); }
    }

    function renderPlexTab() {
        if (!plexConfigured()) {
            return `
                <div class="lg-empty">
                    <p>Plex isn't connected yet. Connect a Plex server in Settings to browse the curated audiophile reference catalog against your library.</p>
                    <button class="lg-secondary-btn" id="lgPlexOpenSettings">Open Settings</button>
                </div>
            `;
        }
        return `
            <p class="lg-help">100 audiophile reference tracks scored against your Plex library. Pick one and the model will draft a full lesson.</p>
            <div class="lg-plex-toolbar">
                <span class="lg-plex-status" id="lgPlexHeader">Loading Plex matches…</span>
                <button class="lg-secondary-btn lg-rescan-btn" id="lgPlexRescan" style="display:none">Rescan</button>
            </div>
            <div class="lg-plex-list" id="lgPlexList">
                <div class="lg-plex-loading"><span class="lg-spinner"></span> Scanning library…</div>
            </div>
            <div class="lg-status" id="lgStatus"></div>
            <div class="lg-preview-host" id="lgPreviewHost"></div>
        `;
    }

    function bindPlexTab() {
        const overlay = document.getElementById('lessonGenOverlay');
        overlay?.querySelector('#lgPlexOpenSettings')?.addEventListener('click', () => {
            const settingsBtn = document.getElementById('settingsBtn');
            if (settingsBtn) { closeModal(); settingsBtn.click(); }
        });
        if (plexConfigured()) {
            // Kick off the scan (or load from cache)
            startPlexScan(false);
        }
        overlay?.querySelector('#lgPlexRescan')?.addEventListener('click', () => startPlexScan(true));
    }

    async function startPlexScan(forceRescan) {
        const overlay = document.getElementById('lessonGenOverlay');
        const listEl  = overlay?.querySelector('#lgPlexList');
        const headEl  = overlay?.querySelector('#lgPlexHeader');
        const rescanEl = overlay?.querySelector('#lgPlexRescan');
        if (!listEl || !headEl) return;

        // 1. Fetch catalog
        let catalog;
        try {
            const res = await fetch('/data/reference-catalog.json');
            catalog = await res.json();
        } catch (e) {
            listEl.innerHTML = `<div class="lg-plex-error">Could not load reference catalog: ${escHtml(e.message)}</div>`;
            return;
        }
        if (!Array.isArray(catalog) || catalog.length === 0) {
            listEl.innerHTML = `<div class="lg-plex-error">Reference catalog is empty.</div>`;
            return;
        }

        const urlHash = plexUrlHash();
        const fp = catalogFingerprint(catalog);
        const cache = loadPlexScanCache();
        const cached = cache[urlHash];

        // 2. Use cache if valid
        if (!forceRescan && cached && cached.catalogFingerprint === fp && cached.matches) {
            renderPlexResults(catalog, cached.matches, headEl, listEl, rescanEl);
            return;
        }

        // 3. Scan Plex (sequential, with progress)
        if (typeof HiFiBuddyPlex === 'undefined') {
            listEl.innerHTML = `<div class="lg-plex-error">Plex module not loaded.</div>`;
            return;
        }
        const matches = {};
        for (let i = 0; i < catalog.length; i++) {
            const cand = catalog[i];
            headEl.textContent = `Scanned ${i} of ${catalog.length}…`;
            try {
                const hit = await HiFiBuddyPlex.searchTrack(cand.track, cand.artist);
                if (hit && hit.ratingKey) {
                    matches[cand.id] = {
                        plexRatingKey: String(hit.ratingKey),
                        title: hit.title || cand.track,
                        artist: hit.artist || cand.artist,
                        album: hit.album || cand.album || '',
                    };
                } else {
                    matches[cand.id] = null;
                }
            } catch (e) {
                matches[cand.id] = null;
            }
        }

        // 4. Persist
        cache[urlHash] = {
            scannedAt: Date.now(),
            catalogFingerprint: fp,
            matches,
        };
        savePlexScanCache(cache);

        renderPlexResults(catalog, matches, headEl, listEl, rescanEl);
    }

    function renderPlexResults(catalog, matches, headEl, listEl, rescanEl) {
        const hits = catalog.filter(c => matches[c.id]);
        headEl.textContent = `${hits.length} of ${catalog.length} reference tracks matched in your Plex library`;
        if (rescanEl) rescanEl.style.display = '';

        if (hits.length === 0) {
            listEl.innerHTML = `
                <div class="lg-empty">
                    <p>No matches found. Either Plex isn't reachable, or none of the curated reference tracks are in your library yet. Use Rescan if you've recently added music.</p>
                </div>
            `;
            return;
        }

        listEl.innerHTML = hits.map(c => {
            const m = matches[c.id];
            const skills = (c.primarySkills || []).map(s =>
                `<span class="lg-plex-skill">${escHtml(SKILL_LABELS[s] || s)}</span>`
            ).join('');
            return `
                <div class="lg-plex-card" data-cand="${escHtml(c.id)}">
                    <div class="lg-plex-card-main">
                        <div class="lg-plex-title">${escHtml(c.track)}</div>
                        <div class="lg-plex-meta">
                            <span class="lg-plex-artist">${escHtml(c.artist)}</span>
                            <span class="lg-plex-sep">·</span>
                            <span class="lg-plex-album">${escHtml(c.album || '')}${c.year ? ` (${c.year})` : ''}</span>
                        </div>
                        <div class="lg-plex-skills">${skills}</div>
                        <p class="lg-plex-note">${escHtml(c.audiophileNote || '')}</p>
                    </div>
                    <button class="lg-plex-go" data-cand="${escHtml(c.id)}" title="Generate lesson for this track">
                        Generate Lesson
                    </button>
                </div>
            `;
        }).join('');

        listEl.querySelectorAll('.lg-plex-go').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                const cid = btn.dataset.cand;
                const cand = catalog.find(c => c.id === cid);
                if (!cand) return;
                runPlexCardGenerate(cand, btn);
            });
        });
    }

    async function runPlexCardGenerate(cand, btnEl) {
        const overlay = document.getElementById('lessonGenOverlay');
        const status  = overlay?.querySelector('#lgStatus');
        const ident   = `${cand.artist} - ${cand.track}` + (cand.album ? ` (from ${cand.album}${cand.year ? `, ${cand.year}` : ''})` : '');
        const focus   = (cand.primarySkills && cand.primarySkills[0]) || '';
        await runGeneration({
            input: ident,
            opts: { focusSkill: focus || undefined, albumHint: cand.album || undefined },
            statusEl: status,
            btnEl,
        });
    }

    // ===== Tab D: Import pack =====

    function renderImportTab() {
        return `
            <p class="lg-help">Load a <code>proposed-lessons.json</code> file produced by <code>propose_lessons.py</code>. Review each draft, then import the ones you want to keep.</p>
            <div class="lg-import-controls">
                <label class="lg-file-btn">
                    <input type="file" id="lgImportFile" accept=".json" style="display:none" />
                    <span>Choose proposed-lessons.json…</span>
                </label>
                <span class="lg-import-filename" id="lgImportFilename"></span>
            </div>
            <div class="lg-import-list" id="lgImportList"></div>
            <div class="lg-import-actions" id="lgImportActions" style="display:none">
                <button class="lg-secondary-btn" id="lgImportSelectOk">Select OK only</button>
                <button class="lg-generate-btn" id="lgImportGo">Import selected</button>
            </div>
            <div class="lg-status" id="lgStatus"></div>
        `;
    }

    function bindImportTab() {
        const overlay = document.getElementById('lessonGenOverlay');
        overlay?.querySelector('#lgImportFile')?.addEventListener('change', handleImportFile);
        overlay?.querySelector('#lgImportSelectOk')?.addEventListener('click', () => {
            overlay.querySelectorAll('.lg-import-row').forEach(row => {
                const cb = row.querySelector('input[type=checkbox]');
                const status = row.dataset.status;
                if (cb) cb.checked = (status === 'ok');
            });
        });
        overlay?.querySelector('#lgImportGo')?.addEventListener('click', runImport);
    }

    function handleImportFile(e) {
        const file = e.target.files?.[0];
        if (!file) return;
        // CROSS-BROWSER: iOS Safari ignores the <input accept=".json"> attribute,
        // so users can pick any file. Validate filename + MIME on the JS side
        // and surface a clean error before we hand bytes to JSON.parse.
        const looksJson = /\.json$/i.test(file.name) || (file.type && /json/i.test(file.type));
        if (!looksJson) {
            const overlay = document.getElementById('lessonGenOverlay');
            const status = overlay?.querySelector('#lgStatus');
            setStatus(status, 'error', 'Please choose a .json file (proposed-lessons.json).');
            if (typeof HiFiBuddyToast !== 'undefined') {
                HiFiBuddyToast.error('Please choose a .json file.');
            }
            e.target.value = '';
            return;
        }
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const parsed = JSON.parse(ev.target.result);
                const lessons = Array.isArray(parsed?.lessons) ? parsed.lessons : null;
                if (!lessons) throw new Error('File missing top-level "lessons" array.');
                importPackState = { fileName: file.name, lessons };
                renderImportList();
            } catch (err) {
                const overlay = document.getElementById('lessonGenOverlay');
                const status = overlay?.querySelector('#lgStatus');
                setStatus(status, 'error', 'Could not parse file: ' + err.message);
            }
        };
        reader.readAsText(file);
    }

    function renderImportList() {
        const overlay = document.getElementById('lessonGenOverlay');
        const fileEl  = overlay?.querySelector('#lgImportFilename');
        const listEl  = overlay?.querySelector('#lgImportList');
        const actEl   = overlay?.querySelector('#lgImportActions');
        if (!listEl || !importPackState) return;

        if (fileEl) fileEl.textContent = importPackState.fileName;
        const records = importPackState.lessons;

        if (records.length === 0) {
            listEl.innerHTML = `<div class="lg-empty"><p>File contained no lessons.</p></div>`;
            if (actEl) actEl.style.display = 'none';
            return;
        }

        listEl.innerHTML = records.map((rec, idx) => {
            const status = rec.status || 'unknown';
            const lesson = rec.lesson;
            const errs = Array.isArray(rec.errors) ? rec.errors.filter(Boolean) : [];
            const score = (typeof rec.score === 'number') ? rec.score : null;
            const importable = status === 'ok' || status === 'needs_review';
            const defaultChecked = status === 'ok';

            const title = lesson?.title || rec.candidateId || 'Untitled lesson';
            const album = lesson?.album || {};
            const track = lesson?.track || {};
            const meta  = lesson
                ? `${escHtml(album.artist || '')} — "${escHtml(track.title || '')}"` +
                  (album.title ? ` <span class="lg-import-album">(${escHtml(album.title)}${album.year ? `, ${album.year}` : ''})</span>` : '')
                : `<span class="lg-import-meta-empty">Candidate ${escHtml(rec.candidateId || '?')} — no lesson body</span>`;

            const badgeClass = status === 'ok' ? 'ok' : (status === 'ai_failed' ? 'failed' : 'review');
            const badgeText  = status === 'ok' ? 'OK' : (status === 'ai_failed' ? 'AI Failed' : 'Needs Review');

            const errBlock = errs.length
                ? `<details class="lg-import-errors"><summary>${errs.length} error${errs.length > 1 ? 's' : ''}</summary><ul>${errs.map(e => `<li>${escHtml(e)}</li>`).join('')}</ul></details>`
                : '';

            const previewBlock = lesson
                ? `<div class="lg-import-preview"><strong>Intro:</strong> ${escHtml((lesson.guide?.intro || '').slice(0, 240))}${(lesson.guide?.intro || '').length > 240 ? '…' : ''}</div>`
                : '';

            return `
                <div class="lg-import-row" data-idx="${idx}" data-status="${status}">
                    <label class="lg-import-checkrow">
                        <input type="checkbox" ${defaultChecked ? 'checked' : ''} ${importable ? '' : 'disabled'} />
                        <div class="lg-import-row-main">
                            <div class="lg-import-row-head">
                                <span class="lg-import-title">${escHtml(title)}</span>
                                <span class="lg-import-badge lg-import-badge-${badgeClass}">${badgeText}</span>
                                ${score !== null ? `<span class="lg-import-score">Score ${score}</span>` : ''}
                            </div>
                            <div class="lg-import-row-meta">${meta}</div>
                            ${errBlock}
                            ${previewBlock}
                        </div>
                    </label>
                </div>
            `;
        }).join('');

        if (actEl) actEl.style.display = 'flex';
    }

    function runImport() {
        const overlay = document.getElementById('lessonGenOverlay');
        const status  = overlay?.querySelector('#lgStatus');
        if (!importPackState || !Array.isArray(importPackState.lessons)) {
            setStatus(status, 'error', 'No file loaded.');
            return;
        }
        const rows = overlay.querySelectorAll('.lg-import-row');
        let imported = 0;
        let lastTitle = '';
        rows.forEach(row => {
            const cb = row.querySelector('input[type=checkbox]');
            if (!cb || !cb.checked || cb.disabled) return;
            const idx = +row.dataset.idx;
            const rec = importPackState.lessons[idx];
            if (!rec || !rec.lesson) return;
            const lesson = {
                ...rec.lesson,
                id: newLessonId(),
                generated: true,
                generatedAt: Date.now(),
            };
            saveUserLesson(lesson);
            imported++;
            lastTitle = lesson.title;
        });

        if (imported === 0) {
            setStatus(status, 'error', 'Nothing checked to import.');
            return;
        }

        if (typeof HiFiBuddyToast !== 'undefined') {
            HiFiBuddyToast.success(`Imported ${imported} lesson${imported > 1 ? 's' : ''}.`);
        }
        setStatus(status, 'ok', `Imported ${imported} lesson${imported > 1 ? 's' : ''}.`);

        // Notify dashboard, close after a beat
        window.dispatchEvent(new CustomEvent('hifibuddy-user-lesson-created', {
            detail: { imported, lastTitle }
        }));
        setTimeout(closeModal, 900);
    }

    // ===== Unified generate-and-review =====

    async function runGeneration({ input, opts, statusEl, btnEl }) {
        if (btnEl) btnEl.disabled = true;
        setStatus(statusEl, 'busy', '<span class="lg-spinner"></span> Composing lesson… 15-30 seconds.');
        try {
            const lesson = await generate(input, opts || {});
            pendingLesson = lesson;
            renderPreview(lesson);
            setStatus(statusEl, 'ok', `Drafted <strong>${escHtml(lesson.title)}</strong>. Review below, then Save or Discard.`);
        } catch (e) {
            console.warn('[LessonGen] generate failed:', e);
            renderGenerationError(statusEl, e, { input, opts, btnEl });
        } finally {
            if (btnEl) btnEl.disabled = false;
        }
    }

    // Build a richer error card that surfaces (a) what broke, (b) why
    // (the actual error text — including model output if validation failed),
    // and (c) what to do (Retry, Copy raw, Open Settings).
    function renderGenerationError(statusEl, err, ctx) {
        if (!statusEl) return;
        const detail = err?.message || String(err) || 'unknown error';
        const raw = (err && err.rawResponse) ? String(err.rawResponse).slice(0, 2000) : '';
        // Heuristic: classify the failure to pick the headline.
        let what, why;
        if (/No AI backend/i.test(detail)) {
            what = 'AI is not configured';
            why = 'Set an Ollama URL or Claude API key in Settings.';
        } else if (/unreachable|Failed to fetch|NetworkError/i.test(detail)) {
            what = 'Cannot reach the AI backend';
            why = detail;
        } else if (/Validation failed/i.test(detail)) {
            what = 'AI returned invalid JSON';
            why = detail;
        } else if (/returned\s+\d{3}/i.test(detail)) {
            what = 'AI service returned an error';
            why = detail;
        } else {
            what = 'Could not generate lesson';
            why = detail;
        }

        statusEl.className = 'lg-status lg-status-error lg-status-card';
        statusEl.innerHTML = `
            <div class="lg-error-card">
                <div class="lg-error-head"><strong>${escHtml(what)}</strong></div>
                <div class="lg-error-why">${escHtml(why)}</div>
                <div class="lg-error-actions">
                    <button class="lg-secondary-btn" data-act="retry">Retry</button>
                    ${raw ? '<button class="lg-secondary-btn" data-act="copy-raw">Copy raw response</button>' : ''}
                    <button class="lg-secondary-btn" data-act="open-settings">Open Settings</button>
                </div>
                ${raw ? `<details class="lg-error-raw"><summary>Show raw model output</summary><pre>${escHtml(raw)}</pre></details>` : ''}
            </div>
        `;
        const retryBtn = statusEl.querySelector('[data-act=retry]');
        retryBtn?.addEventListener('click', () => runGeneration(ctx));
        const copyBtn = statusEl.querySelector('[data-act=copy-raw]');
        copyBtn?.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(raw);
                if (typeof HiFiBuddyToast !== 'undefined') HiFiBuddyToast.success('Raw response copied to clipboard.');
            } catch {
                if (typeof HiFiBuddyToast !== 'undefined') HiFiBuddyToast.error('Could not copy — clipboard blocked.');
            }
        });
        const settingsBtn = statusEl.querySelector('[data-act=open-settings]');
        settingsBtn?.addEventListener('click', () => {
            // Settings gear is in the page header; clicking it opens the modal
            // even when our overlay is on top.
            document.getElementById('settingsBtn')?.click();
        });
    }

    function renderPreview(lesson) {
        const overlay = document.getElementById('lessonGenOverlay');
        const host = overlay?.querySelector('#lgPreviewHost');
        if (!host) return;
        const skills = (lesson.skills || []).map(s =>
            `<span class="lg-preview-skill">${escHtml(SKILL_LABELS[s] || s)}</span>`
        ).join('');
        const cues = (lesson.guide?.listenFor || []).slice(0, 4).map(c =>
            `<li><span class="lg-preview-time">${escHtml(c.time)}</span> <span class="lg-preview-skill-mini">${escHtml(SKILL_LABELS[c.skill] || c.skill)}</span> ${escHtml((c.note || '').slice(0, 140))}${(c.note || '').length > 140 ? '…' : ''}</li>`
        ).join('');

        host.innerHTML = `
            <div class="lg-preview">
                <div class="lg-preview-head">
                    <h4>${escHtml(lesson.title)}</h4>
                    <span class="lg-preview-diff">${escHtml(lesson.difficulty || '')}</span>
                </div>
                <div class="lg-preview-meta">
                    ${escHtml(lesson.album?.artist || '')} — "${escHtml(lesson.track?.title || '')}"
                    ${lesson.album?.title ? `<span class="lg-preview-album"> · ${escHtml(lesson.album.title)}${lesson.album.year ? ` (${lesson.album.year})` : ''}</span>` : ''}
                </div>
                <div class="lg-preview-skills">${skills}</div>
                <p class="lg-preview-intro">${escHtml(lesson.guide?.intro || '')}</p>
                <ul class="lg-preview-cues">${cues}${(lesson.guide?.listenFor || []).length > 4 ? `<li class="lg-preview-more">+${lesson.guide.listenFor.length - 4} more cue${lesson.guide.listenFor.length - 4 > 1 ? 's' : ''}…</li>` : ''}</ul>
                <p class="lg-preview-takeaway"><strong>Takeaway:</strong> ${escHtml(lesson.guide?.takeaway || '')}</p>
                <div class="lg-preview-actions">
                    <button class="lg-secondary-btn" id="lgDiscardBtn">Discard</button>
                    <button class="lg-generate-btn" id="lgSaveBtn">Save to my lessons</button>
                </div>
            </div>
        `;

        host.querySelector('#lgDiscardBtn')?.addEventListener('click', discardPreview);
        host.querySelector('#lgSaveBtn')?.addEventListener('click', saveAndClose);
    }

    function discardPreview() {
        pendingLesson = null;
        const overlay = document.getElementById('lessonGenOverlay');
        const host = overlay?.querySelector('#lgPreviewHost');
        const status = overlay?.querySelector('#lgStatus');
        if (host) host.innerHTML = '';
        if (status) { status.className = 'lg-status'; status.textContent = ''; }
    }

    function saveAndClose() {
        if (!pendingLesson) return;
        const lesson = { ...pendingLesson, id: newLessonId() };
        saveUserLesson(lesson);
        if (typeof HiFiBuddyToast !== 'undefined') {
            HiFiBuddyToast.success(`Saved "${lesson.title}".`);
        }
        window.dispatchEvent(new CustomEvent('hifibuddy-user-lesson-created', {
            detail: { lessonId: lesson.id }
        }));
        pendingLesson = null;
        setTimeout(closeModal, 600);
    }

    // ===== Status helper =====

    function setStatus(el, kind, html) {
        if (!el) return;
        el.className = 'lg-status' + (kind ? ' lg-status-' + kind : '');
        el.innerHTML = html || '';
    }

    return { open, generate, listUserLessons, deleteUserLesson };
})();
