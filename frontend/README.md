# Kiln Controller (New UI)

This directory contains the new React + TypeScript + Vite UI.

Key constraint: the kiln should be able to deploy by `git pull` + restart only.
So the built output is committed into `public/app/` and served by Bottle at `/app`.

## Local dev

From repo root:

```bash
cd frontend
npm install
npm run dev
```

Recommended: also run the Python server on `:8080` (separate terminal), so Vite can proxy legacy
WS/HTTP endpoints:

```bash
source kilnenv/bin/activate && PORT=8080 DEVELOPMENT=1 ./kiln-controller.py
```

Then open the Vite URL it prints (it should auto-open at `/app/`).

## Build (commits output into `public/app/`)

```bash
cd frontend
npm run build
```

Notes:

- The Vite `base` is set to `/app/`.
- Build output goes to `../public/app/` (outside this directory).
