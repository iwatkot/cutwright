---
name: cutwright-user-docs
description: Maintain CutWright's detailed end-user manual on the website whenever the editor's features, behavior, controls, or user workflows change. Also use for writing or reviewing CutWright user documentation; exclude unrelated products.
---

# CutWright user documentation

The user manual belongs to the separate `cutwright-website` project, in `content/docs/`; generated pages live under `dist/docs/`. Follow the website README for generation and verification. In the shared Windows workspace it is the sibling of the editor checkout. The website source repository, `https://github.com/iwatkot/cutwright-website`, is private; use an authorized checkout. The canonical public app repository is `https://github.com/iwatkot/cutwright`.

## Keep documentation part of the change

- Every CutWright change requires a documentation review and a corresponding update. New features, bug fixes that affect results, changed controls/defaults/shortcuts, and removed behavior must update the relevant user guide in the same task before delivery. Never defer documentation for a new feature.
- For a change with no observable user effect, record the review in the website's maintenance record instead of adding implementation details to the manual. Do not silently skip the documentation review.
- Treat exact visible labels, icon location, values, available choices, mouse/keyboard gestures, expected results, and recovery/cancel/undo steps as part of the documented behavior. Review cross-links and related workflows when a control moves or changes name.
- If the website checkout is unavailable, locate the existing repository or obtain its source without touching unrelated work. Report a real access blocker; do not claim documentation is current when it was not updated.

## Write only for the person using the editor

- Describe how to accomplish a task, starting from the screen the person can see: what to click, which field to change, what value means, what happens next, and how to correct a mistake. Use numbered instructions for procedures and clear field references for the available controls.
- Cover every exposed function, including less obvious context menus, track actions, modifier keys, import/relink behavior, text presets, guide placement, save/open/recovery, export progress/cancel, and practical limitations. Verify each against the current UI and source; never invent a button or familiar feature from another editor.
- Keep instructions detailed enough for a first-time user. Avoid feature summaries that omit the actual clicks. Explain differences that change a user's action, such as saving an editable project versus exporting a video.
- Do not publish architecture, APIs, tool schemas, data models, framework/library names, test reports, developer setup, build commands, implementation history, or internal identifiers in the user manual. Necessary visible file types and settings are fine when they help the person use the app.
- Document agent connection from the user's side only: opening the dialog, enabling/disconnecting, copying the displayed configuration into a compatible client, and asking for an edit. Do not change the editor's agent protocol merely to expose the website manual; the user explicitly clarified that requirement.

## Verify the maintained manual

Regenerate the website pages after editing article sources. Check links and section anchors, inspect changed layouts at desktop and mobile widths, and try meaningful revised steps in an isolated editor project. Do not use or overwrite the person's original media/projects for documentation checks.

Keep source coverage/maintenance records outside published guide prose. For ordinary visual, code, or feature changes, read the repository AGENTS.md and this skill before working, then include the documentation update in the final change description.
