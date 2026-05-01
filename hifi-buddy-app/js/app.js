/**
 * HiFi Buddy — standalone app bootstrap.
 *
 * Initializes all modules, wires up nav between the Lessons view (HiFi Buddy)
 * and the Reference Library view.
 */
(() => {
    'use strict';

    let currentView = 'lessons';
    let lessonsContainer = null;
    let refbankContainer = null;
    let statsContainer = null;
    let lessonsRendered = false;
    let refbankRendered = false;

    function setActiveNav(view) {
        document.querySelectorAll('.hb-nav-btn').forEach(btn => {
            const isActive = btn.dataset.view === view;
            btn.classList.toggle('active', isActive);
            // a11y: announce active nav target as the current page so screen
            // readers don't depend on the visual `.active` class alone.
            if (isActive) btn.setAttribute('aria-current', 'page');
            else btn.removeAttribute('aria-current');
        });
    }

    function showView(view) {
        currentView = view;
        if (view === 'lessons') {
            lessonsContainer.style.display = '';
            refbankContainer.style.display = 'none';
            if (statsContainer) statsContainer.style.display = 'none';
            if (!lessonsRendered) {
                HiFiBuddyApp.render(lessonsContainer, navigate);
                lessonsRendered = true;
            }
        } else if (view === 'refbank') {
            lessonsContainer.style.display = 'none';
            refbankContainer.style.display = '';
            if (statsContainer) statsContainer.style.display = 'none';
            if (!refbankRendered) {
                HiFiBuddyRefBank.render(refbankContainer);
                refbankRendered = true;
            }
        } else if (view === 'stats') {
            lessonsContainer.style.display = 'none';
            refbankContainer.style.display = 'none';
            if (statsContainer) statsContainer.style.display = '';
            // Always re-render so the dashboard reflects newly persisted ABX results.
            if (typeof HiFiBuddyAbxStats !== 'undefined' && statsContainer) {
                HiFiBuddyAbxStats.render(statsContainer);
            }
        }
        setActiveNav(view);
    }

    // Navigate callback handed to HiFi Buddy module — currently used for
    // sub-view routing (lesson → dashboard) which it manages internally.
    function navigate(/* dest */) {
        // HiFi Buddy handles its own internal nav (dashboard/lesson/skills/AI).
        // This hook is kept for future use (e.g., navigating away to refbank).
    }

    async function initializeModules() {
        // Settings MUST initialize first and to completion: it loads durable
        // config from ~/.hifi-buddy/config.json into the in-memory cache and
        // migrates any legacy localStorage values. Other modules will read
        // settings synchronously during their own init, so the cache must be
        // populated before they run.
        if (typeof HiFiBuddySettings !== 'undefined') await HiFiBuddySettings.init();
        if (typeof HiFiBuddyAudio !== 'undefined') HiFiBuddyAudio.init?.();
        if (typeof HiFiBuddySpotify !== 'undefined') HiFiBuddySpotify.init();
        if (typeof HiFiBuddyPlex !== 'undefined') HiFiBuddyPlex.init?.();
        if (typeof HiFiBuddyMB !== 'undefined') HiFiBuddyMB.init();
        if (typeof HiFiBuddyRefBank !== 'undefined') HiFiBuddyRefBank.init?.();
        if (typeof HiFiBuddyAbxStats !== 'undefined') HiFiBuddyAbxStats.init?.();
        // ABX + timing-feedback both reconcile localStorage with their
        // server-side durable stores at boot. Awaiting them keeps stats
        // and overrides correct on first render.
        if (typeof HiFiBuddyABX !== 'undefined') {
            try { await HiFiBuddyABX.init?.(); } catch (e) { console.warn('[ABX] bootstrap:', e); }
        }
        if (typeof HiFiBuddyTimingFeedback !== 'undefined') {
            try { await HiFiBuddyTimingFeedback.init?.(); } catch (e) { console.warn('[TimingFeedback] bootstrap:', e); }
        }
        if (typeof HiFiBuddyVisualizer !== 'undefined') HiFiBuddyVisualizer.init();
        // HiFi Buddy's init takes a genres parameter; standalone app has no genre data.
        if (typeof HiFiBuddyApp !== 'undefined') HiFiBuddyApp.init(null);
    }

    function bindNav() {
        document.querySelectorAll('.hb-nav-btn').forEach(btn => {
            btn.addEventListener('click', () => showView(btn.dataset.view));
        });
        // Logo also acts as "go to lessons"
        document.querySelector('.hb-logo')?.addEventListener('click', e => {
            e.preventDefault();
            showView('lessons');
        });
    }

    async function init() {
        lessonsContainer = document.getElementById('lessonsContainer');
        refbankContainer = document.getElementById('refbankContainer');
        statsContainer = document.getElementById('statsContainer');
        if (!lessonsContainer || !refbankContainer) {
            console.error('[HiFi Buddy] Required containers missing');
            return;
        }
        await initializeModules();
        bindNav();
        showView('lessons');

        // Onboarding: auto-launches if not completed; supports
        // ?onboarding=1 (force) and ?reset_onboarding=1 (clear flag + relaunch).
        if (typeof HiFiBuddyOnboarding !== 'undefined') {
            HiFiBuddyOnboarding.init();
        }

        console.log('[HiFi Buddy] Standalone app ready.');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
