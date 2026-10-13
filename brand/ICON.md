# Home-screen icon

`icon.png` is this app's tile on the Homeroom home screen, declared in
`dapp.json` as `"icon": { "image": "brand/icon.png" }`. The platform reads it
at deploy time; the app never serves it, which is why it lives outside
`public/`.

The tile is custom artwork, not the shared Homeroom tile style: a white
line-art pocong from the image attached to Homeroom request #38 by scraido2,
the app's creator.

- Artwork: a simple white outline drawing of a pocong — a knot on top, an
  oval head, crossed wrapping over the body, and a curling tail to the lower
  left — no face. Cropped from the rounded-square tile in that image (the
  purple gradient around it was the mockup backdrop, not the icon).
- Colour: the tile's own dark slate-teal (`#324e59`) as one continuous field
  all the way to the edges; none of the mockup's purple backdrop or its
  rounded-corner curve shows.
- 512 × 512 PNG, full bleed, no text, no transparency (8-bit RGB, no alpha
  channel). The platform rounds and crops the tile itself. The app name is
  not on the tile; the platform prints it underneath.

To change the tile, replace `icon.png` and update this note. The change
applies once the proposal is voted in and deployed.

## Site favicon

The site favicon and touch icons are a separate, original SVG cartoon pocong
(request #23), not the tile artwork:

- Glyph: a pocong in dirty beige burial cloth (`#d8c69c` to `#a99266`),
  knotted on top, wrapped in crossing bands, with a ragged hem and a wispy
  curled tail to the left. Pale face, dark-ringed round eyes, small "ooo" mouth.
- Badge: a round slate/navy disc (`#3a4760` to `#161c29`, ring `#5a6883`).
- Source: `public/icon.svg` (transparent outside the badge).
  `public/apple-touch-icon.png` (180, on `#121722`) and `public/favicon-32.png`
  (32, transparent) are renders of the same SVG.

To change them, edit `public/icon.svg` and re-render the PNGs from it, for
example with headless Chromium.
