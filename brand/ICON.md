# Home-screen icon

`icon.png` is this app's tile on the Homeroom home screen, declared in
`dapp.json` as `"icon": { "image": "brand/icon.png" }`. The platform reads it
at deploy time; the app never serves it, which is why it lives outside
`public/`.

It is the app's own artwork (request #23), not the shared Lucide tile style:

- Glyph: an original cartoon pocong in dirty beige burial cloth (`#d8c69c`
  to `#a99266`), knotted on top, wrapped in crossing bands, with a ragged hem
  and a wispy curled tail off to the left. The face is pale, with dark-ringed
  mismatched round eyes and a small open "ooo" mouth.
- Badge: a round slate/navy disc (`#3a4760` to `#161c29`, ring `#5a6883`).
- Source: `public/icon.svg` (transparent outside the badge), which is also the
  site favicon. The tile is that SVG rendered at 512 x 512 on a plain
  `#121722` background, so it is opaque and full bleed. `public/apple-touch-icon.png`
  (180, same background) and `public/favicon-32.png` (32, transparent) are
  renders of the same SVG.

To change the icon, edit `public/icon.svg` and re-render the PNGs from it, for
example with headless Chromium:
`headless_shell --window-size=512,512 --screenshot=brand/icon.png page.html`
where `page.html` shows the SVG on the `#121722` background.
