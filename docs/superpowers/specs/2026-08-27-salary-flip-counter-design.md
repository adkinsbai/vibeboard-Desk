# Salary Flip Counter Design

## Goal

Build and deploy a 480x360 salary counter for the gray RK3566 VibeBoard. It shows today's accrued pay for a 09:00-18:00 workday at CNY 1,000 per hour and makes the increase feel tangible through independent mechanical flip digits.

## User Experience

- The screen is a restrained black stadium-scoreboard surface with subtle brushed metal texture and green illumination.
- A compact calendar header shows the local date and performs one page-turn animation on load and when the local day changes.
- The main amount uses four independent flip cards. Changed places animate separately, including carries from ones to tens, hundreds, and thousands.
- The cards show the integer amount from `0000` through `9000`; leading zeroes are visually dimmed.
- A smaller line shows the precise amount to two decimals, so money visibly increases even when the main integer has not changed.
- A thin progress rail and status copy show whether the workday is waiting, earning, or complete.

## Salary Rules

- Before 09:00 local device time: CNY 0.00.
- From 09:00 through 18:00: `elapsed work hours * 1000`, clamped to the shift.
- At and after 18:00: CNY 9,000.00.
- The date and amount reset automatically on the next local day.
- The precise amount refreshes four times per second; flip cards animate only when their integer changes.

## Technical Shape

- Pure HTML, CSS, and JavaScript with no network or external runtime dependency.
- Project source lives under `market-apps/vb-salary-flip-counter/`.
- The generated bitmap is decorative only; CSS supplies a deterministic fallback if it is unavailable.
- `hardware_app.py` remains system-owned and unchanged in behavior. This application requests no microphone, camera, GPIO, or other hardware capability.
- Deployment replaces only the board's static application files after a timestamped backup.

## Verification

- Unit-test salary boundaries and progress calculations.
- Run repository syntax checks and hardware-contract verification.
- Render at exactly 480x360 with Playwright, assert key text/values, and inspect the screenshot.
- Confirm SSH reachability, back up the current static directory, deploy, restart `taishan-screen.service`, and verify the served page and service state.

