/**
 * HiFi Buddy ABX Progress Dashboard
 *
 * Reads localStorage.hifibuddy_abx_results — { lessonId: [result, ...] } —
 * and renders aggregate stats: total sessions, pass rate, discrimination floor
 * by bitrate, per-lesson grid, and a 5-session moving-average trend chart.
 *
 * Public API:
 *   init()              — call once at app boot
 *   render(container)   — render into the given DOM container
 */
window.HiFiBuddyAbxStats = (() => {
    'use strict';

    const RESULTS_KEY = 'hifibuddy_abx_results';

    // Colors per bitrate. Match common audiophile shorthand: lower = redder.
    const BITRATE_COLORS = {
        320: '#5a8df0', // blue
        256: '#4ca56b', // green
        192: '#e0a44e', // amber
        128: '#d65a5a', // red
    };

    // Lesson catalog cache (lazy-loaded from data/hifi-guide.json so we can
    // show real titles instead of bare IDs).
    let lessonTitleMap = null;
    let lessonTitlePromise = null;

    function loadLessonTitles() {
        if (lessonTitleMap) return Promise.resolve(lessonTitleMap);
        if (lessonTitlePromise) return lessonTitlePromise;
        lessonTitlePromise = fetch('data/hifi-guide.json', { cache: 'force-cache' })
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                lessonTitleMap = {};
                if (data && Array.isArray(data.lessons)) {
                    data.lessons.forEach(l => { lessonTitleMap[l.id] = l.title; });
                }
                return lessonTitleMap;
            })
            .catch(() => { lessonTitleMap = {}; return lessonTitleMap; });
        return lessonTitlePromise;
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function readResults() {
        try {
            return JSON.parse(localStorage.getItem(RESULTS_KEY) || '{}') || {};
        } catch { return {}; }
    }

    function flatten(byLesson) {
        const out = [];
        Object.keys(byLesson).forEach(lessonId => {
            (byLesson[lessonId] || []).forEach(r => {
                out.push(Object.assign({ lessonId }, r));
            });
        });
        return out;
    }

    function fmtPct(v, digits = 1) {
        if (!isFinite(v)) return '—';
        return `${v.toFixed(digits)}%`;
    }

    function fmtDate(ts) {
        if (!ts) return '—';
        const d = new Date(ts);
        if (isNaN(d.getTime())) return '—';
        const now = Date.now();
        const diffDays = Math.floor((now - ts) / 86400000);
        if (diffDays === 0) return 'today';
        if (diffDays === 1) return 'yesterday';
        if (diffDays < 7) return `${diffDays}d ago`;
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
    }

    function fmtP(p) {
        if (p == null || !isFinite(p)) return '—';
        if (p < 0.001) return 'p<0.001';
        if (p < 0.01) return 'p<0.01';
        return `p=${p.toFixed(3)}`;
    }

    // Pass: p<0.05. Borderline: 0.05 ≤ p < 0.20. Below: p ≥ 0.20.
    function passClass(p) {
        if (p == null) return 'amber';
        if (p < 0.05) return 'green';
        if (p < 0.20) return 'amber';
        return 'red';
    }

    // ===== Aggregate computations =====

    function computeAggregates(byLesson) {
        const all = flatten(byLesson);
        const totalSessions = all.length;
        const passSessions = all.filter(r => r.pValue != null && r.pValue < 0.05).length;
        const passRate = totalSessions ? (passSessions / totalSessions) * 100 : 0;
        const uniqueLessons = Object.keys(byLesson).filter(k => byLesson[k] && byLesson[k].length).length;
        const totalCorrect = all.reduce((s, r) => s + (r.correct || 0), 0);
        const totalTrials = all.reduce((s, r) => s + (r.trials || 0), 0);
        const avgScore = totalTrials ? (totalCorrect / totalTrials) * 100 : 0;
        return { totalSessions, passSessions, passRate, uniqueLessons, avgScore, totalCorrect, totalTrials };
    }

    function computeBitrateBreakdown(byLesson) {
        const all = flatten(byLesson);
        const buckets = {};
        all.forEach(r => {
            const br = r.bitrate;
            if (!br) return;
            if (!buckets[br]) buckets[br] = { sessions: 0, passes: 0, totalCorrect: 0, totalTrials: 0 };
            buckets[br].sessions += 1;
            if (r.pValue != null && r.pValue < 0.05) buckets[br].passes += 1;
            buckets[br].totalCorrect += r.correct || 0;
            buckets[br].totalTrials += r.trials || 0;
        });
        return Object.keys(buckets)
            .map(k => Number(k))
            .sort((a, b) => b - a)
            .map(br => {
                const b = buckets[br];
                const passPct = b.sessions ? (b.passes / b.sessions) * 100 : 0;
                const accPct = b.totalTrials ? (b.totalCorrect / b.totalTrials) * 100 : 0;
                return { bitrate: br, ...b, passPct, accPct };
            });
    }

    function computePerLesson(byLesson) {
        return Object.keys(byLesson).map(lessonId => {
            const sessions = (byLesson[lessonId] || []).slice().sort((a, b) => (a.completedAt || 0) - (b.completedAt || 0));
            const latest = sessions[sessions.length - 1];
            const lastTested = latest ? latest.completedAt : 0;
            const passes = sessions.filter(r => r.pValue != null && r.pValue < 0.05).length;
            return {
                lessonId,
                sessions,
                latest,
                lastTested,
                count: sessions.length,
                passes,
            };
        }).filter(x => x.count > 0)
          .sort((a, b) => (b.lastTested || 0) - (a.lastTested || 0));
    }

    // 5-session moving window over chronological sessions (across all lessons).
    function computeTrend(byLesson) {
        const all = flatten(byLesson)
            .filter(r => r.completedAt)
            .sort((a, b) => a.completedAt - b.completedAt);
        if (all.length === 0) return [];
        const window = 5;
        const points = [];
        for (let i = 0; i < all.length; i++) {
            const start = Math.max(0, i - window + 1);
            const slice = all.slice(start, i + 1);
            const passes = slice.filter(r => r.pValue != null && r.pValue < 0.05).length;
            const passRate = (passes / slice.length) * 100;
            points.push({ idx: i + 1, t: all[i].completedAt, passRate });
        }
        return points;
    }

    // ===== Render helpers =====

    function renderHeaderCard(agg) {
        return `
            <div class="abxs-header">
                <div class="abxs-stat">
                    <div class="abxs-stat-num">${agg.totalSessions}</div>
                    <div class="abxs-stat-label">Total ABX sessions</div>
                </div>
                <div class="abxs-stat">
                    <div class="abxs-stat-num">${fmtPct(agg.passRate, 0)}</div>
                    <div class="abxs-stat-label">Pass rate (p&lt;0.05)</div>
                </div>
                <div class="abxs-stat">
                    <div class="abxs-stat-num">${agg.uniqueLessons}</div>
                    <div class="abxs-stat-label">Lessons tested</div>
                </div>
                <div class="abxs-stat">
                    <div class="abxs-stat-num">${fmtPct(agg.avgScore, 1)}</div>
                    <div class="abxs-stat-label">Avg trial accuracy</div>
                </div>
            </div>
        `;
    }

    function renderBitrateBars(buckets) {
        if (!buckets.length) return '';
        const rows = buckets.map(b => {
            const color = BITRATE_COLORS[b.bitrate] || '#7a7a90';
            const cls = b.passPct >= 60 ? 'green' : (b.passPct >= 40 ? 'amber' : 'red');
            const label = `At ${b.bitrate} kbps you correctly distinguished FLAC in ${b.passes} of ${b.sessions} sessions (${fmtPct(b.passPct, 1)}).`;
            return `
                <div class="abxs-bar-row">
                    <div class="abxs-bar-head">
                        <span class="abxs-bar-bitrate" style="color:${color}">${b.bitrate} kbps</span>
                        <span class="abxs-bar-meta">${b.passes}/${b.sessions} pass · ${fmtPct(b.accPct, 1)} trial acc.</span>
                    </div>
                    <div class="abxs-bar-track">
                        <div class="abxs-bar-fill abxs-${cls}" style="width:${Math.max(2, b.passPct).toFixed(1)}%; background:${color}"></div>
                    </div>
                    <div class="abxs-bar-caption">${escapeHtml(label)}</div>
                </div>
            `;
        }).join('');
        return `
            <div class="abxs-section">
                <h3 class="abxs-section-title">Discrimination floor</h3>
                <p class="abxs-section-sub">Pass rate by lossy bitrate. Green = you reliably hear the difference; red = you don't.</p>
                ${rows}
            </div>
        `;
    }

    function renderPerLesson(lessons, titleMap) {
        if (!lessons.length) return '';
        const cards = lessons.map(l => {
            const title = (titleMap && titleMap[l.lessonId]) || l.lessonId;
            const latest = l.latest || {};
            const correct = latest.correct != null ? latest.correct : '—';
            const trials = latest.trials != null ? latest.trials : '—';
            const cls = passClass(latest.pValue);
            const tick = latest.pValue != null && latest.pValue < 0.05 ? '<span class="abxs-tick">PASS</span>' : '';
            const br = latest.bitrate ? `${latest.bitrate} kbps` : '';
            return `
                <button class="abxs-lesson-card" data-lesson-id="${escapeHtml(l.lessonId)}">
                    <div class="abxs-lesson-head">
                        <div class="abxs-lesson-title">${escapeHtml(title)}</div>
                        <div class="abxs-lesson-id">${escapeHtml(l.lessonId)}</div>
                    </div>
                    <div class="abxs-lesson-score">
                        <span class="abxs-score-num abxs-${cls}">${correct}/${trials}</span>
                        ${tick}
                    </div>
                    <div class="abxs-lesson-meta">
                        <span>${fmtP(latest.pValue)}</span>
                        <span>${escapeHtml(br)}</span>
                        <span>${l.count} session${l.count === 1 ? '' : 's'}</span>
                        <span>${fmtDate(l.lastTested)}</span>
                    </div>
                </button>
            `;
        }).join('');
        return `
            <div class="abxs-section">
                <h3 class="abxs-section-title">Per-lesson</h3>
                <div class="abxs-lesson-grid">${cards}</div>
            </div>
        `;
    }

    function renderTrendChart(points) {
        if (points.length < 2) return '';
        const W = 640, H = 160, PAD_L = 36, PAD_R = 12, PAD_T = 12, PAD_B = 28;
        const innerW = W - PAD_L - PAD_R;
        const innerH = H - PAD_T - PAD_B;
        const xFor = i => PAD_L + (points.length === 1 ? 0 : (i / (points.length - 1)) * innerW);
        const yFor = pct => PAD_T + innerH - (pct / 100) * innerH;

        // Polyline path
        const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xFor(i).toFixed(1)},${yFor(p.passRate).toFixed(1)}`).join(' ');

        // Y-axis grid (0/50/100)
        const grid = [0, 50, 100].map(v => `
            <line x1="${PAD_L}" y1="${yFor(v)}" x2="${W - PAD_R}" y2="${yFor(v)}" stroke="var(--border-subtle)" stroke-dasharray="2 4"/>
            <text x="${PAD_L - 6}" y="${yFor(v) + 4}" text-anchor="end" fill="var(--text-muted)" font-size="10">${v}%</text>
        `).join('');

        // 50% reference (chance) — emphasised
        const chance = `<line x1="${PAD_L}" y1="${yFor(50)}" x2="${W - PAD_R}" y2="${yFor(50)}" stroke="var(--text-muted)" stroke-dasharray="4 4" opacity="0.5"/>`;

        // Dots
        const dots = points.map((p, i) => `<circle cx="${xFor(i).toFixed(1)}" cy="${yFor(p.passRate).toFixed(1)}" r="3" fill="#9b59b6"/>`).join('');

        // X labels (first / last)
        const first = points[0], last = points[points.length - 1];
        const xLabels = `
            <text x="${xFor(0)}" y="${H - 8}" text-anchor="start" fill="var(--text-muted)" font-size="10">session #${first.idx}</text>
            <text x="${xFor(points.length - 1)}" y="${H - 8}" text-anchor="end" fill="var(--text-muted)" font-size="10">session #${last.idx}</text>
        `;

        const direction = last.passRate > first.passRate ? 'improving' :
            (last.passRate < first.passRate ? 'softening' : 'flat');
        const directionCopy = {
            improving: "Trend up. Your ear is getting more sensitive at the bitrates you've been testing.",
            softening: "Trend down. Either you're testing harder bitrates or you're listening tired. Both happen.",
            flat: "Flat. You've found your floor — try dropping a bitrate notch to push it.",
        }[direction];

        return `
            <div class="abxs-section">
                <h3 class="abxs-section-title">Trend</h3>
                <p class="abxs-section-sub">5-session moving average of pass rate. ${escapeHtml(directionCopy)}</p>
                <svg class="abxs-trend" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" role="img" aria-label="Pass rate trend">
                    ${grid}
                    ${chance}
                    <path d="${pathD}" fill="none" stroke="#9b59b6" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
                    ${dots}
                    ${xLabels}
                </svg>
            </div>
        `;
    }

    function renderEmpty() {
        return `
            <div class="abxs-empty">
                <div class="abxs-empty-icon">
                    ${HiFiBuddyIcons.activity({ size: 48, strokeWidth: 1.6 })}
                </div>
                <h3>No ABX results yet</h3>
                <p>Run an ABX test in any lesson to start seeing your stats here.</p>
                <button class="abxs-empty-cta" id="abxsGoLessons">Go to lessons</button>
            </div>
        `;
    }

    // ===== Public render =====

    function render(container) {
        if (!container) return;
        const byLesson = readResults();
        const total = flatten(byLesson).length;

        if (total === 0) {
            container.innerHTML = `
                <div class="abxs-wrap">
                    <header class="abxs-pageheader">
                        <h2>ABX Stats</h2>
                        <p>Aggregate listening-test results across all lessons.</p>
                    </header>
                    ${renderEmpty()}
                </div>
            `;
            const goBtn = container.querySelector('#abxsGoLessons');
            if (goBtn) goBtn.addEventListener('click', () => {
                const lessonsBtn = document.querySelector('.hb-nav-btn[data-view="lessons"]');
                if (lessonsBtn) lessonsBtn.click();
            });
            return;
        }

        const agg = computeAggregates(byLesson);
        const buckets = computeBitrateBreakdown(byLesson);
        const trend = computeTrend(byLesson);

        // Render shell first; lessons section gets re-rendered after titles load.
        container.innerHTML = `
            <div class="abxs-wrap">
                <header class="abxs-pageheader">
                    <h2>ABX Stats</h2>
                    <p>Aggregate listening-test results across all lessons.</p>
                </header>
                ${renderHeaderCard(agg)}
                ${renderBitrateBars(buckets)}
                ${renderTrendChart(trend)}
                <div id="abxsLessonsMount"></div>
            </div>
        `;

        const perLesson = computePerLesson(byLesson);
        loadLessonTitles().then(titleMap => {
            const mount = container.querySelector('#abxsLessonsMount');
            if (!mount) return;
            mount.innerHTML = renderPerLesson(perLesson, titleMap);
            mount.querySelectorAll('.abxs-lesson-card').forEach(card => {
                card.addEventListener('click', () => {
                    const id = card.dataset.lessonId;
                    // Navigate to lessons view; emit a hint event for any listener.
                    const lessonsBtn = document.querySelector('.hb-nav-btn[data-view="lessons"]');
                    if (lessonsBtn) lessonsBtn.click();
                    window.dispatchEvent(new CustomEvent('hifibuddy-open-lesson', { detail: { lessonId: id } }));
                    try { window.location.hash = id; } catch { /* ignore */ }
                });
            });
        });
    }

    function init() {
        // Nothing to wire globally — the view is rendered on nav switch.
    }

    return { init, render };
})();
