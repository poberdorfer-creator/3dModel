# Radial engine — hidden-line viewer

Interactive hidden-line (vector-style) render of the animated radial pneumatic engine GLB, styled with [tactic.studio](https://tactic.studio) light/dark palettes.

## Run locally

```bash
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

## Controls

- **Drag** — orbit the model
- **Scroll** — scrub the looped animation (`Take 001`, ~2.96s)
- **Space** — pause / resume auto-play (auto-play resumes a few seconds after you stop scrolling)
- **Theme** — toggle dark/light (persists via `localStorage` key `tactic-theme`, same as tactic.studio)

## Asset

The model is served from `public/radial_pneumatic_engine.glb` (copied from your Downloads file). Replace that file to update the mesh/animation.
