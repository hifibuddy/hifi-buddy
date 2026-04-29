/**
 * HiFi Buddy Toast Notifications
 * Global notification system for user feedback.
 *
 * Backward-compatible API:
 *   HiFiBuddyToast.success(msg [, duration])
 *   HiFiBuddyToast.error(msg [, duration])
 *   HiFiBuddyToast.warning(msg [, duration])
 *   HiFiBuddyToast.info(msg [, duration])
 *   HiFiBuddyToast.show(msg, type, duration)
 *
 * Extended API (new):
 *   HiFiBuddyToast.show({
 *     message: string,
 *     type: 'success'|'error'|'warning'|'info',
 *     duration: number,            // ms, default 6000 for error/warning, 4000 for info/success
 *     action: { label, onClick },  // optional: shows a button inside the toast
 *     details: string,             // optional: collapsible "Show details" with raw text
 *   })
 *
 * Also installs a global error boundary (window.error / unhandledrejection)
 * that surfaces uncaught exceptions through a discrete toast. Capped to
 * 3 toasts/minute to avoid spam.
 */
window.HiFiBuddyToast = (() => {
    'use strict';

    let container = null;

    // Global error boundary throttle.
    const _errBoundaryStamps = [];
    const ERR_BOUNDARY_LIMIT = 3;     // toasts per window
    const ERR_BOUNDARY_WINDOW_MS = 60_000;
    let _errBoundaryInstalled = false;

    function init() {
        if (container) return;
        container = document.createElement('div');
        container.className = 'toast-container';
        document.body.appendChild(container);
        installErrorBoundary();
    }

    // Toast icons. Stroke-width 2, 16px — matches HiFiBuddyIcons defaults.
    // Lazy resolution lets toast.js continue to function even if icons.js
    // failed to load (we fall back to nothing rather than throwing).
    const ICONS = {
        get success() { return window.HiFiBuddyIcons ? HiFiBuddyIcons.check() : ''; },
        get error()   { return window.HiFiBuddyIcons ? HiFiBuddyIcons.xCircle() : ''; },
        get warning() { return window.HiFiBuddyIcons ? HiFiBuddyIcons.warningDot() : ''; },
        get info()    { return window.HiFiBuddyIcons ? HiFiBuddyIcons.info() : ''; },
    };

    function escHtml(s) {
        const d = document.createElement('div');
        d.textContent = s == null ? '' : String(s);
        return d.innerHTML;
    }

    // Default durations: error/warning linger longer so users can read them
    // and click the action button before they auto-dismiss.
    function defaultDuration(type) {
        if (type === 'error' || type === 'warning') return 6000;
        return 4000;
    }

    // The original signature was show(message, type, duration). Keep that
    // working AND accept a single options-object for the richer variants.
    function show(arg1, arg2, arg3) {
        if (!container) init();

        let opts;
        if (arg1 && typeof arg1 === 'object' && !Array.isArray(arg1)) {
            opts = arg1;
        } else {
            opts = { message: arg1, type: arg2, duration: arg3 };
        }

        const type = opts.type || 'info';
        const message = opts.message == null ? '' : String(opts.message);
        const duration = (opts.duration === 0)
            ? 0  // 0 = sticky, never auto-dismiss
            : (opts.duration || defaultDuration(type));
        const action = opts.action || null;
        const details = opts.details ? String(opts.details) : '';

        const toast = document.createElement('div');
        toast.className = `toast toast-${type}` + (action || details ? ' toast-rich' : '');

        const iconHtml = ICONS[type] || ICONS.info;

        // Body: icon + text + (optional action) + (optional details disclosure)
        const textHtml = `<span class="toast-text">${escHtml(message)}</span>`;
        const actionHtml = action && action.label
            ? `<button type="button" class="toast-action-btn">${escHtml(action.label)}</button>`
            : '';
        const detailsHtml = details
            ? `<details class="toast-details"><summary>Show details</summary><pre class="toast-details-pre">${escHtml(details)}</pre></details>`
            : '';

        toast.innerHTML = `
            <div class="toast-row">
                ${iconHtml}
                ${textHtml}
                ${actionHtml}
            </div>
            ${detailsHtml}
        `;
        container.appendChild(toast);

        requestAnimationFrame(() => toast.classList.add('toast-visible'));

        let timer = null;
        const startTimer = () => {
            if (duration <= 0) return;
            clearTimer();
            timer = setTimeout(() => dismiss(toast), duration);
        };
        const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
        startTimer();

        // Click anywhere on the toast (except action button / details) to dismiss.
        toast.addEventListener('click', (e) => {
            const t = e.target;
            if (t.closest('.toast-action-btn')) return;
            if (t.closest('.toast-details')) return;
            clearTimer();
            dismiss(toast);
        });

        // Action button — call user callback, then dismiss.
        if (action && action.label) {
            const btn = toast.querySelector('.toast-action-btn');
            btn?.addEventListener('click', (e) => {
                e.stopPropagation();
                clearTimer();
                try {
                    if (typeof action.onClick === 'function') action.onClick();
                } catch (err) {
                    console.warn('[Toast] action handler threw:', err);
                }
                dismiss(toast);
            });
        }

        // Pause auto-dismiss while the user is mousing over (or has details open).
        toast.addEventListener('mouseenter', clearTimer);
        toast.addEventListener('mouseleave', startTimer);

        return toast;
    }

    function dismiss(toast) {
        if (!toast) return;
        toast.classList.remove('toast-visible');
        toast.addEventListener('transitionend', () => toast.remove(), { once: true });
        // Fallback removal in case transition doesn't fire
        setTimeout(() => { if (toast.parentNode) toast.remove(); }, 500);
    }

    function success(msg, dur) { return show({ message: msg, type: 'success', duration: dur }); }
    function error(msg, dur)   { return show({ message: msg, type: 'error',   duration: dur }); }
    function warning(msg, dur) { return show({ message: msg, type: 'warning', duration: dur }); }
    function info(msg, dur)    { return show({ message: msg, type: 'info',    duration: dur }); }

    // Convenience: error toast with an action button. Equivalent to
    // show({ type: 'error', message, action: { label, onClick } }).
    function errorWithAction(msg, label, onClick, opts = {}) {
        return show({
            type: 'error',
            message: msg,
            action: { label, onClick },
            details: opts.details,
            duration: opts.duration,
        });
    }
    function infoWithAction(msg, label, onClick, opts = {}) {
        return show({
            type: 'info',
            message: msg,
            action: { label, onClick },
            details: opts.details,
            duration: opts.duration,
        });
    }

    // ===== Global error boundary =====

    function shouldEmitBoundaryToast() {
        const now = Date.now();
        // Drop stamps older than the window
        while (_errBoundaryStamps.length && now - _errBoundaryStamps[0] > ERR_BOUNDARY_WINDOW_MS) {
            _errBoundaryStamps.shift();
        }
        if (_errBoundaryStamps.length >= ERR_BOUNDARY_LIMIT) return false;
        _errBoundaryStamps.push(now);
        return true;
    }

    function summarizeError(err) {
        if (!err) return '(no detail)';
        if (typeof err === 'string') return err;
        const msg = err.message || err.reason?.message || String(err);
        return msg || '(no detail)';
    }

    function detailFromError(err) {
        if (!err) return '';
        if (typeof err === 'string') return err;
        if (err.stack) return String(err.stack);
        if (err.reason && err.reason.stack) return String(err.reason.stack);
        try { return JSON.stringify(err, null, 2); } catch { return String(err); }
    }

    function installErrorBoundary() {
        if (_errBoundaryInstalled) return;
        _errBoundaryInstalled = true;

        window.addEventListener('error', (ev) => {
            // Filter resource-load errors (img/script/css) — those have no error obj
            // and would spam on every missing thumbnail.
            if (!ev.error && !ev.message) return;
            if (!shouldEmitBoundaryToast()) return;
            const msg = summarizeError(ev.error || ev.message);
            show({
                type: 'error',
                message: `Something went wrong: ${msg}. Open DevTools for full trace.`,
                details: detailFromError(ev.error || ev),
                duration: 8000,
            });
        });

        window.addEventListener('unhandledrejection', (ev) => {
            if (!shouldEmitBoundaryToast()) return;
            const reason = ev.reason;
            const msg = summarizeError(reason);
            show({
                type: 'error',
                message: `Unhandled rejection: ${msg}. Open DevTools for full trace.`,
                details: detailFromError(reason),
                duration: 8000,
            });
        });
    }

    return {
        init, show, success, error, warning, info,
        errorWithAction, infoWithAction,
        dismiss,
    };
})();
