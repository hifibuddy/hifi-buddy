# HiFi Buddy — marketing site

Static, framework-free landing page for HiFi Buddy, the open-source
critical-listening tutor.

## Run locally

This is just static HTML/CSS/JS. Serve it any way you like:

```bash
# python (matches the parent project's stack)
python3 -m http.server 8080

# or with node
npx serve .
```

Then open `http://localhost:8080` in a browser.

## Structure

```
hifi-buddy-site/
  index.html
  css/styles.css
  js/main.js
  assets/favicon.svg
```

## Tech

- No build step, no bundler, no framework.
- Inter + JetBrains Mono via Google Fonts.
- Inline SVG icons.
- IntersectionObserver-based scroll reveal.

## Deployment

Deployed at [hifibuddy.net](https://hifibuddy.net) on Vercel as a static site.
Repo: [hifibuddy/hifi-buddy](https://github.com/hifibuddy/hifi-buddy) (the
marketing site lives in `hifi-buddy-site/`; the runtime app lives in
`hifi-buddy-app/`).

## TODO before public launch

- Generate `assets/og-image.png` — a 1200x630 social-card PNG, dark theme
  matching the hero (purple/indigo gradient on `#0a0a0f`, "HiFi Buddy" mark,
  the eyebrow line "Stop guessing. Start hearing."). The `<meta>` tags in
  `index.html` already point to `/assets/og-image.png`; you just need to
  drop the file in.
- Add `<link rel="canonical" href="https://hifibuddy.net/">` in
  `index.html` once DNS is live (the domain isn't registered yet).
