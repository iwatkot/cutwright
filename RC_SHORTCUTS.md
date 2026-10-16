# Release-candidate shortcut inventory

Researched 2026-10-16. This is a bounded comparison with Movavi's documented keyboard shortcuts, not a promise to reproduce its entire product. The table records both the accepted baseline and the current RC source. Fresh UI reports, rather than this inventory alone, establish tested behavior. The RC bindings also appear in accessible in-app shortcut help.

## Official evidence

Movavi's [official manuals index](https://www.movavi.com/support/manuals.html) links the Windows [2026 shortcut table](https://img.movavi.com/online-help/videoeditorplus/26/hotkeys.htm) and [2027 shortcut table](https://img.movavi.com/online-help/videoeditorplus/27/hotkeys.htm). Both explicitly identify **Ctrl+M** as the marker shortcut. The [Mac 2026 table](https://img.movavi.com/online-help/video-editor-plus-mac/26/hotkeys.htm) identifies **Command+M**. The deep pages were retrieved directly over HTTPS because the search reader could not open them; no third-party shortcut list is the basis of this inventory.

| Status | Movavi Windows documentation | CutWright baseline / RC relevance |
| --- | --- | --- |
| Existing | Arrow keys step frames; Home/End go to timeline limits; Ctrl+S saves. | Same actions; preserve. History, playback and deletion are also already keyboard accessible. |
| Added in RC | Ctrl+B splits. | Ctrl+B now aliases the retained C / Ctrl+K split bindings. |
| Different | Ctrl+O imports; Ctrl+F opens projects. | Ctrl+O opens projects; import has a visible button. Preserve established project behavior and label any added import shortcut honestly. |
| Different | Shift+Arrow skips 0.5 seconds. | Shift+Arrow skips 1 second; document it. |
| Existing, broader | Ctrl++ / Ctrl+- zoom the timeline. | Bare + / - also work. Avoid consuming unrelated modified keys. |
| Added in RC | Ctrl+M adds a marker; Up/Down navigate clips. | Ctrl+M adds a persistent marker; Up/Down seek the previous/next clip boundary. |
| Missing | Ctrl+D clones a clip; Alt+Arrow moves selected clips. | Useful future additions only with complete linked-clip/history semantics. |
| Missing / different feature | New/Save As, recording, freeze frame, animation, Blade/Selection tools, fullscreen. | Inventory only. Ctrl+E currently focuses export; it does not insert a freeze frame. These features do not all become RC requirements. |

The [marker guide](https://img.movavi.com/online-help/videoeditorplus/26/markers.htm) documents naming and removal. The [snapping guide](https://img.movavi.com/online-help/videoeditorplus/26/snapping.htm) documents alignment with markers and clip boundaries. Neither inspected shortcut table assigns marker-navigation or snapping-toggle keys: any such RC keys are **CutWright bindings**.

## Current RC bindings

The RC source provides Ctrl+M to add a marker, Ctrl+Shift+Left/Right for previous/next marker, S to toggle timeline snapping, Ctrl+B as a split alias, and Up/Down for clip-boundary navigation. Ctrl/Command +/− and bare +/− zoom the timeline. Command substitutes for Ctrl on platforms where the browser supplies Meta. Marker and snapping bindings are discoverable in the timeline and shortcut help. Alt-drag temporarily bypasses timeline or canvas snapping.

Project opening retains Ctrl+O; Ctrl+E retains focus-export behavior. Shift+Arrow still seeks one second. The documented missing operations in the table remain outside this RC; no clone, recording, freeze-frame or full Movavi feature-parity claim is made.

Global editor shortcuts must respect `defaultPrevented`, IME composition, open dialogs, editable fields and custom slider/combobox/control keyboard scopes. Preserve text-field undo/redo and focused-button activation. After explicit commands, ignore unhandled Ctrl/Command/Alt combinations. Marker and canvas operations remain ordinary project semantics with save/open/recovery and exact undo/redo; editor aids never enter exported pixels.

## RC2 workspace interactions

Hold Shift while dragging out or moving a canvas guide to use its axis's configured grid spacing and origin (100 px by default), including when the grid is hidden. Release Shift for whole-pixel positioning. Modifier changes take effect without moving the pointer. Dragging outside the frame still removes a guide.

Right-click timeline content for a custom context menu. Add marker uses the clicked time, including horizontal scroll. Clip, marker, and transition targets offer their relevant editing actions. Shift+F10 or the Context Menu key opens timeline actions at the playhead when the timeline has focus; arrows, Home/End, Enter, Escape and Tab provide keyboard access.

Over the preview, the mouse wheel zooms around the pointer. Middle-drag or hold Space and left-drag to pan; Fit restores the centered fitted view. Zoom is relative to Fit, from 25% to 800%. Preview navigation is local editor view state and does not change clip transforms, saved project data, export dimensions or editing history. Space elsewhere retains normal playback behavior, and typing fields retain their native text behavior.
