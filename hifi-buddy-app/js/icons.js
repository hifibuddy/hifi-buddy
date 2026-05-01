// HiFi Buddy — single source of truth for inline SVG icons.
//
// Goals:
//   - One canonical path per icon. Change stroke width / shape once,
//     change everywhere.
//   - Centralized aria handling. Decorative by default, ariaLabel for
//     interactive icons.
//   - Easy theming: icons inherit color via `currentColor`. Override
//     color from CSS (parent `color:`) or wrap the call in a span.
//
// Conventions:
//   - 24x24 viewBox
//   - currentColor stroke (or fill for solid icons)
//   - stroke-width 2 by default, configurable via opts.strokeWidth
//   - stroke-linecap/linejoin "round"
//   - Default size is 16px
//
// Usage:
//   HiFiBuddyIcons.check()                             // 16px decorative
//   HiFiBuddyIcons.check({ size: 14 })                 // smaller
//   HiFiBuddyIcons.check({ strokeWidth: 3 })           // bolder
//   HiFiBuddyIcons.check({ ariaLabel: 'Completed' })   // accessible
//   HiFiBuddyIcons.play()                              // solid (filled) icon
//
// Brand icons (Spotify, YouTube) use their brand-mark fill — they don't
// recolor through currentColor on purpose. Wrap in a span with `style="color:#1DB954"`
// if you want the parent context to set the color, or pass `{ brand: false }` to
// fall back to currentColor.
window.HiFiBuddyIcons = (() => {
    'use strict';

    function escapeAttr(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;');
    }

    // Stroke-style icon (the common case). Inner shapes use the outer
    // svg's stroke + currentColor + round caps/joins.
    function svg(inner, opts) {
        opts = opts || {};
        const size = opts.size || 16;
        const sw = opts.strokeWidth != null ? opts.strokeWidth : 2;
        const cls = opts.className ? ` class="${escapeAttr(opts.className)}"` : '';
        const id = opts.id ? ` id="${escapeAttr(opts.id)}"` : '';
        const styleAttr = opts.style ? ` style="${escapeAttr(opts.style)}"` : '';
        const aria = opts.ariaLabel
            ? `role="img" aria-label="${escapeAttr(opts.ariaLabel)}"`
            : 'aria-hidden="true"';
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" width="${size}" height="${size}"${cls}${id}${styleAttr} ${aria}>${inner}</svg>`;
    }

    // Filled icon (solid shape, no stroke). For play triangles, filled stars, etc.
    function solid(inner, opts) {
        opts = opts || {};
        const size = opts.size || 16;
        const cls = opts.className ? ` class="${escapeAttr(opts.className)}"` : '';
        const id = opts.id ? ` id="${escapeAttr(opts.id)}"` : '';
        const styleAttr = opts.style ? ` style="${escapeAttr(opts.style)}"` : '';
        const aria = opts.ariaLabel
            ? `role="img" aria-label="${escapeAttr(opts.ariaLabel)}"`
            : 'aria-hidden="true"';
        const fill = opts.fillColor ? escapeAttr(opts.fillColor) : 'currentColor';
        return `<svg viewBox="0 0 24 24" fill="${fill}" width="${size}" height="${size}"${cls}${id}${styleAttr} ${aria}>${inner}</svg>`;
    }

    // Each function below returns the SVG string. Add new icons alphabetically.
    return {
        // Trend chart — used in stats empty state.
        activity:     (o) => svg('<path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-7"/>', o),
        // Left-arrow used in "Back" buttons.
        arrowLeft:    (o) => svg('<path d="M19 12H5m0 0l7 7m-7-7l7-7"/>', o),
        // Right-arrow / chevron used as "next" affordance on lesson cards.
        arrowRight:   (o) => svg('<path d="M9 18l6-6-6-6"/>', o),
        // Bar chart — "Skill Progress" affordance.
        barChart:     (o) => svg('<path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/>', o),
        // 4-arrow "expand" / dimensions corners — used on A/B button.
        boxCorners:   (o) => svg('<path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3M3 16v3a2 2 0 002 2h3m10 0h3a2 2 0 002-2v-3"/>', o),
        check:        (o) => svg('<polyline points="20 6 9 17 4 12"/>', o),
        // Clipboard with checkmark — used as the ABX badge.
        checkSquare:  (o) => svg('<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 14l2 2 4-4"/>', o),
        chevronUp:    (o) => svg('<polyline points="18 15 12 9 6 15"/>', o),
        chevronDown:  (o) => svg('<polyline points="6 9 12 15 18 9"/>', o),
        chevronLeft:  (o) => svg('<polyline points="15 18 9 12 15 6"/>', o),
        chevronRight: (o) => svg('<polyline points="9 18 15 12 9 6"/>', o),
        // Filled circle (used as service-provider color dot — recolor with `style="color:#hex"`).
        circle:       (o) => solid('<circle cx="12" cy="12" r="10"/>', o),
        // Stroke circle with clock-hand — used on hint/tip rows.
        clock:        (o) => svg('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>', o),
        close:        (o) => svg('<path d="M18 6 6 18M6 6l12 12"/>', o),
        // Computer / desktop device icon (Spotify Connect device list).
        computer:     (o) => svg('<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>', o),
        // Devices / media-bay (Spotify "Devices" button).
        devices:      (o) => svg('<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>', o),
        download:     (o) => svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>', o),
        // Pencil / edit.
        edit:         (o) => svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>', o),
        // Sliders/equalizer 3-bar icon — "Skill Progress" or audio-meter.
        equalizer:    (o) => svg('<path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/>', o),
        // Folder icon — used for local library + Plex/local source badges.
        folder:       (o) => svg('<path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>', o),
        // Stroke-only headphones — primary brand mark.
        headphones:   (o) => svg('<path d="M3 18v-6a9 9 0 0118 0v6"/><path d="M21 19a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3v5zM3 19a2 2 0 002 2h1a2 2 0 002-2v-3a2 2 0 00-2-2H3v5z"/>', o),
        // Info circle (i icon) — variant with thicker dot.
        info:         (o) => svg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/>', o),
        // Info circle with separated lines (toast info variant).
        infoLines:    (o) => svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>', o),
        // Library / 2-shelf book stack — used to label Plex Library row.
        libraryShelves: (o) => svg('<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><circle cx="6" cy="6" r="1"/><circle cx="6" cy="18" r="1"/>', o),
        // Lightbulb-as-microphone? — actually mic.
        mic:          (o) => svg('<path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>', o),
        // Chat bubble — "Listening Coach".
        messageSquare: (o) => svg('<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2v10z"/>', o),
        moon:         (o) => svg('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>', o),
        // Music-note — used many places (track labels, lessons).
        music:        (o) => svg('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>', o),
        // Phone / smartphone (Spotify Connect device list).
        phone:        (o) => svg('<rect x="6" y="2" width="12" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18"/>', o),
        // Solid play triangle — preferred form. Uses currentColor fill.
        play:         (o) => solid('<polygon points="5 3 19 12 5 21 5 3"/>', o),
        // Solid pause — two vertical bars. Pairs with `play` in transports.
        pause:        (o) => solid('<rect x="6" y="4" width="4" height="16" rx="0.5"/><rect x="14" y="4" width="4" height="16" rx="0.5"/>', o),
        // Search magnifier (lucide-style with trailing line).
        search:       (o) => svg('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>', o),
        // Search magnifier alt (with diagonal m21 21-4.35-4.35 path) — used in reference-bank.
        searchAlt:    (o) => svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>', o),
        // Send / paper-plane (coach send button). Uses fill rather than stroke.
        send:         (o) => solid('<path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>', o),
        // Settings cog.
        settings:     (o) => svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>', o),
        // 8-arm sun-ray spinner — used by lesson-generator "Generate" button.
        spinnerRays:  (o) => svg('<path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"/>', o),
        // Frequency-spectrum / waveform.
        spectrum:     (o) => svg('<path d="M3 12h2l3-9 4 18 4-18 3 9h2"/>', o),
        // Speaker (Spotify Connect device list — full speaker icon, partly filled).
        speaker:      (o) => svg('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/>', o),
        // 3-spark sparkle — "Generate New Lesson" button.
        sparkles:     (o) => svg('<path d="M12 3l1.8 4.6L18 9l-4.2 1.6L12 15l-1.8-4.4L6 9l4.2-1.4L12 3z"/><path d="M19 14l.9 2.3L22 17l-2.1.8L19 20l-.9-2.2L16 17l2.1-.7L19 14z"/><path d="M5 16l.6 1.6L7 18l-1.4.5L5 20l-.6-1.5L3 18l1.4-.4L5 16z"/>', o),
        // Single-spark sparkle (one-glyph variant — used on user-lesson cards).
        sparkle:      (o) => svg('<path d="M12 3l1.8 4.6L18 9l-4.2 1.6L12 15l-1.8-4.4L6 9l4.2-1.4L12 3z"/>', o),
        // Spotify brand mark. Default fills with the brand green; pass
        // `{ brand: false }` to fall back to currentColor (for hover states etc).
        spotify: (o) => {
            const opts = o || {};
            const fillColor = opts.brand === false ? 'currentColor' : (opts.fillColor || '#1DB954');
            return solid('<path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.52 17.34c-.24.36-.66.48-1.02.24-2.82-1.74-6.36-2.1-10.56-1.14-.42.12-.78-.18-.9-.54-.12-.42.18-.78.54-.9 4.56-1.02 8.52-.6 11.64 1.32.42.24.48.72.3 1.02zm1.44-3.3c-.3.42-.84.6-1.26.3-3.24-1.98-8.16-2.58-11.94-1.38-.48.12-.99-.12-1.14-.6-.12-.48.12-.99.6-1.14 4.38-1.32 9.78-.66 13.5 1.62.36.18.54.78.24 1.2z"/>', { ...opts, fillColor });
        },
        // Filled star.
        starFilled:   (o) => solid('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>', o),
        // Outline star.
        starOutline:  (o) => svg('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>', o),
        // Star with 5-leg point (alternate path used in reference-bank/quality scoring).
        starFilled5:  (o) => solid('<path d="M12 2l2.95 6.5L22 9.6l-5.2 5 1.4 7.4L12 18.6 5.8 22l1.4-7.4L2 9.6l7.05-1.1L12 2z"/>', o),
        starOutline5: (o) => svg('<path d="M12 2l2.95 6.5L22 9.6l-5.2 5 1.4 7.4L12 18.6 5.8 22l1.4-7.4L2 9.6l7.05-1.1L12 2z"/>', o),
        sun:          (o) => svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>', o),
        // Reset / refresh — circular arrow (left-only variant).
        reset:        (o) => svg('<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>', o),
        trash:        (o) => svg('<path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/>', o),
        // TV (Spotify Connect device list).
        tv:           (o) => svg('<rect x="2" y="5" width="20" height="14" rx="2"/><polyline points="8 21 12 17 16 21"/>', o),
        upload:       (o) => svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>', o),
        // Triangle warning (Lucide alert-triangle).
        warning:      (o) => svg('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>', o),
        // Same triangle warning, dot-style (toast variant).
        warningDot:   (o) => svg('<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>', o),
        // Compact warning (small dot variant — used in line guides).
        warningCompact: (o) => svg('<path d="M12 9v4M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>', o),
        // Generic X — matches `close` but kept as a separate name when used
        // for "wrong/incorrect" semantics (e.g., ABX trial result).
        x:            (o) => svg('<path d="M18 6 6 18M6 6l12 12"/>', o),
        // X-in-circle — toast error icon.
        xCircle:      (o) => svg('<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>', o),
        // YouTube brand mark.
        youtube: (o) => {
            const opts = o || {};
            return solid('<path d="M23.5 6.2a3 3 0 00-2.1-2.1C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.4.6A3 3 0 00.5 6.2 31.4 31.4 0 000 12a31.4 31.4 0 00.5 5.8 3 3 0 002.1 2.1c1.9.6 9.4.6 9.4.6s7.5 0 9.4-.6a3 3 0 002.1-2.1A31.4 31.4 0 0024 12a31.4 31.4 0 00-.5-5.8zM9.6 15.6V8.4l6.3 3.6-6.3 3.6z"/>', opts);
        },
    };
})();
