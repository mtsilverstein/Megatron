# Two drafts at once

Keep two Megatron tabs open:

- Gabagool: `index.html?league=gabagool` — the existing live Sleeper overlay.
- ESPN family: `index.html?league=espnfam` — manual entry; no picks are sent to ESPN.

Gabagool is the priority. The ESPN manual log is saved separately by league and
season in this browser. Neither tab changes the other's scoring configuration.
Use the same browser/profile when returning to a saved ESPN draft. Browser data
clearing, private browsing, or a different device may prevent recovery; export a
backup periodically. Read the save status: a storage failure is not a saved draft.

## ESPN workflow

1. Enter your actual draft **slot**, not your ESPN team ID. Order is randomized
   one hour before the draft; do not assume team ID 7 means slot 7.
2. Type every team's pick in order. Use full names when a surname is ambiguous.
3. Count kickers and defenses too: type the name, then use `+ K` or `+ D/ST`.
4. If you fall behind, collect the missing picks and paste them into **Catch up /
   bulk entry**, one player per line. Use `K: Brandon Aubrey`, `DEF: Seattle`, or
   `OTHER: Name` for unprojected players. Invalid batches add nothing.
5. Check the displayed count against ESPN before trusting the shortlist. Manual
   recommendations are only as current as the picks entered; there is no live
   verification or automatic striking from ESPN.

## Correct mistakes without replaying the draft

Use **Numbered pick history / corrections** to find the error. Select Insert or
Replace and the one-based pick number, then enter the correct player. Deleting
or inserting shifts all later picks and their owners. Undo reverses the last
change in the current page session; the undo stack is not a substitute for a
saved backup.

Avoid editing the same ESPN draft in two tabs. A stale tab refuses to overwrite
a newer save; reload it to resume. Keep Gabagool and ESPN in separate tabs, not
two competing editors for ESPN.

The ESPN league is private. Its signed-in settings matched the board on
2026-09-08, but its draft was still unscheduled at that check. Automatic capture
has not been verified against a live ESPN draft room. Do not share ESPN login
cookies, disable browser protections, or depend on an untested sync bridge.
