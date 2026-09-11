# Skyline Estates

An online, browser-based property-trading board game (Monopoly-style) with live multiplayer, an animated 3D-ish board, three visual themes, power-up cards, auctions, and alliance/team play — all running client-side, no backend server required.

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
skyline-estates/
├── index.html       # page markup only
├── css/
│   └── styles.css    # all styling, including the three theme skins
├── js/
│   ├── lib-loader.js  # CDN fallback loader for PeerJS
│   ├── game.js        # game engine: board, rules, networking, UI wiring
│   └── theme.js        # theme switcher (Modern / Golden / Classic skins)
└── LICENSE
```

`game.js` is currently one large file (a straight extraction from an original single-file build). Breaking it into smaller modules (board, network, cards, UI) is a reasonable follow-up contribution.

## Contributing

Issues and PRs welcome. Please keep changes theme-agnostic where possible (styling lives in `styles.css` under `[data-theme="..."]` selectors, not inline).

## License

See [LICENSE](LICENSE).
