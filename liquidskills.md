# LiquidTruffle Skills

This file is the operating skill file for the LiquidTruffle command center.

## Interface Skill
- Keep chat and terminal as separate panes.
- Terminal pane must stay on the right in desktop layouts.
- Terminal pane must stream live output for running jobs.
- Job status must update in real time (`running`, `completed`, `failed`).

## Execution Skill
- Start jobs through workspace command endpoints.
- Poll running jobs and update the active log stream continuously.
- Preserve recent output tail for assistant job cards.
- Auto-follow logs by default unless the user scrolls away.

## Workspace Skill
- Active workspace drives all direct actions.
- Companion profiles are optional, but must map to real workspaces.
- Keep workspace handling generic and profile-agnostic.

## Reliability Skill
- Do not hide backend errors.
- Print exact error payloads and command failures into the terminal pane.
- Show network and timestamps with every streamed job.

## Deploy Safety Skill
- Use workspace `.env` values for signer configuration.
- Never assume private keys; verify and report signer readiness.
- For chain id failures, surface the mismatch and stop the flow.
