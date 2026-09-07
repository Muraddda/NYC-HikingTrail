# Corridor — Lower Manhattan walk MVP

Personal, free, phone-first. No accounts. No paid APIs.

## What it does

1. Empty map of Lower Manhattan (south of Chambers).
2. Tap start, tap end. Both must be inside the box.
3. Draws a walking route on real streets (free OSRM).
4. Places within 150 m become full pins + a Yes/No card stack, in walking order.
5. Other in-zone Atlas Obscura places shrink to tiny dots. Not tappable.
6. After the stack (or Done early), the walk rebuilds through up to 5 Yes stops. No new pins.

## Test on iPhone (free)

The files cannot live only on this computer. Put the whole `corridor-app` folder on any free static host, then open the URL in Safari.

Fast options:

- Drop the folder on [GitHub Pages](https://pages.github.com/) (free account).
- Publish via Grok Build and open the `grok.me` link.
- On the same Wi-Fi as a laptop: `python3 -m http.server 8000` inside this folder, then visit `http://YOUR-LAPTOP-IP:8000` on the phone.

Then: Safari → Share → **Add to Home Screen**.

Needs cellular or Wi-Fi. Map tiles and the walking router are on the public internet.

## Files

- `index.html` `styles.css` `app.js` — the app
- `places.json` — 23 walkable Atlas Obscura stops
- `manifest.json` `icon.svg` — home-screen extras

## Costs

$0. OpenStreetMap + CARTO tiles, public OSRM foot router, your JSON. If OSRM is busy, Clear and try again. Do not add a Google key.
