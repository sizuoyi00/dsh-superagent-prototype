# Ticket ↔ conversation evidence

Before/after captures for the change that shows the conversation a Ticket came from and the
Ticket's `SU-<n>` key in the conversation's record.

Both sides use the same synthetic state copy (one ShareCRM IM conversation whose request became
SU-8 and completed), the same browser viewport (1800×1100, panel area 1520 px wide) and the
default theme. No private conversation content is used.

| Image | Shows |
| --- | --- |
| `evidence-ticket-card.png` | A My work card: before, only the Source chip; after, the conversation's title, opening its Thread record. |
| `evidence-thread-row.png` | A conversation row: before, only "Tickets ended"; after, `Fans out to SU-8 · …` after the Ticket ended. |
| `evidence-thread-timeline.png` | A conversation timeline: before, the accepted Trigger shows only "Accept"; after, it also links `SU-8`. |

- Baseline: `3a85f0f` (the branch point).
- Changed: `6a785de` (the code commit; `lib/` built from it).
- Captured with a throwaway `shot` DSH profile on port 3084 whose state was a synthetic copy, so
  the live deployment and its sessions were not restarted.
