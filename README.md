# LiquidTruffle

LiquidTruffle is a HyperEVM contract studio and copilot surface.

## Local ports
- API: `http://127.0.0.1:4173`
- Web UI: `http://127.0.0.1:5174`

## Features
- Workspace lifecycle: create, inspect, edit, and run command jobs.
- Contract flow: install, doctor, compile, test, deploy.
- Live execution terminal with streaming logs and status.
- Companion app profile support for deployment handoff checks.

## Security
- `.env` files are ignored.
- Private keys are read from local workspace env only.
- Do not commit secrets.

## Dev
```bash
npm install
npm run dev
```
