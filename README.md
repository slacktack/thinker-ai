# Thinker

A notebook that thinks with you. You write; Thinker questions, explains and draws step-by-step ink sketches in the margin.

- Static site: `index.html`, `app.js`, `ai.js`, `styles.css`. No build step.
- AI: LFM3 bridge at `https://ail.buyhatke.com/lfm` (text with thinking, vision, TTS/ASR). Falls back to a local tutor when offline.
- Run locally: `python3 -m http.server 8765`, then open http://localhost:8765
- Deploy: `vercel` (config in `vercel.json`).
