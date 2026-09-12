# Bankroll

An online, browser-based property-trading board game with live multiplayer, an animated 3D-ish board, three visual themes, power-up cards, auctions, and alliance/team play — all running client-side, no backend server required.

## Playing it

Open `index.html` in a modern browser, or serve the folder locally:

```bash
npx serve .
# or
python3 -m http.server 8000
```

Multiplayer uses [PeerJS](https://peerjs.com/) for peer-to-peer WebRTC connections — one player hosts, others join with a room code. No server-side game logic is required; the host's browser is authoritative.

## Project structure

```
bankroll/
├── index.html       # page markup only
├── css/
│   └── styles.css    # all styling, including the three theme skins
├── js/
│   ├── lib-loader.js    # CDN fallback loader for PeerJS
│   ├── board-render.js  # visual board: theme colors, 3D models, tiles, tokens, center plate
│   ├── cards.js          # power cards + Lucky Wheel/Happy Birthday reveal popup
│   ├── game.js           # game state, turn engine, and UI wiring
│   ├── network.js        # multiplayer: host-authoritative PeerJS room, lobby, sync
│   ├── theme.js          # theme switcher (Modern / Golden / Classic skins)
│   └── accessibility.js  # modal focus management, live regions, keyboard shortcuts
├── assets/
│   ├── logo.svg          # favicon + brand mark
│   ├── models/           # GLB building + car models, loaded by <model-viewer> src=
│   └── sfx/
│       └── dice-roll.mp3 # dice-roll sound effect
└── LICENSE
```

`game.js`, `board-render.js`, `cards.js`, and `network.js` are plain global scripts, not ES modules — they share state across files (players, tiles, rollDice, etc. are plain top-level `let`/`const`/`function`, not attached to `window`), so the `<script>` order in `index.html` matters: `board-render.js`, then `cards.js`, then `game.js`, then `network.js`. `game.js` itself is still the biggest file (turn engine, trading, auctions, end-game summary, and UI wiring all together); splitting those further is a reasonable follow-up contribution.

Binary assets (3D models, audio) live under `assets/` as real files, referenced by relative path from JS — not base64-embedded in source. This keeps the JS text-only and diff-friendly, and lets the browser cache/parallel-load the assets normally.

## Contributing

Issues and PRs welcome. Please keep changes theme-agnostic where possible (styling lives in `styles.css` under `[data-theme="..."]` selectors, not inline).

## License

See [LICENSE](LICENSE).
