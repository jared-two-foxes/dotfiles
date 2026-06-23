# Session Note Format

This file defines the format contract between Lorekeeper and Librarian.
Both agents reference this format. Update it here if the format changes.

## Header (written by Librarian on completion)

<!-- filed: YYYY-MM-DD -->

If this header is present, the note has already been processed by Librarian.

## Entry format (written by Lorekeeper per topic)

### [Topic]
**Summary:** One or two sentences capturing the key insight.
**Details:** Anything worth preserving — behaviour, caveats, gotchas.
**Commands / References:** Relevant commands, file paths, function names.
**Open questions:** Anything unresolved or worth following up.

## Notes

- Entries are appended — never overwritten mid-session
- If a topic is revisited in the same session, a follow-up section is
  added beneath the existing entry rather than replacing it
- Lorekeeper writes at the close of each distinct topic, not per exchange
- Librarian reads the full note on startup and checks for the filed header
