// Manual real-Edge guide interaction test: node tests/guideShift.ui.mjs.
// Each fresh context receives one initial fixture store write. All subsequent
// editing actions are pointer/keyboard UI actions; store access is read-only.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd(), port = 5194, output = path.join(root, 'screenshots', `guide-shift-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const withNavigation = process.argv.includes('--navigation');
mkdirSync(output, { recursive: true });
const sources = () => ['index.html', 'package.json', 'package-lock.json', 'tests/guideShift.ui.mjs', ...readdirSync(path.join(root, 'src'), { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => path.relative(root, path.join(e.parentPath, e.name)).replaceAll('\\', '/'))].sort();
const hashes = () => Object.fromEntries(sources().map(file => [file, createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')]));
const sourceBefore = hashes(), results = [], errors = [], consoleMessages = [], externalRequests = [], environments = [];
const owned = ['src/components/CanvasAids.tsx', 'src/lib/canvasGeometry.ts', 'tests/guideShift.ui.mjs'];
let browser, page, label, config, shiftHeld = false, active;
const canonical = value => JSON.stringify(value, (key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(k => [k, item[k]])) : item);
const check = (name, ok, detail) => { results.push({ name: `${label ? label + ': ' : ''}${name}`, ok: !!ok, ...(detail === undefined ? {} : { detail }) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${label ? label + ': ' : ''}${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`); if (!ok) process.exitCode = 1; return ok; };
const state = () => page.evaluate(() => { const s = window.cutwrightStore.getState(); return { project: s.project, past: s.past.length, future: s.future.length, selectedClipId: s.selectedClipId, playing: s.playing, playhead: s.playhead }; });
const projectJSON = async () => canonical((await state()).project);
const guides = async () => (await state()).project.editorCanvas.guides;
const guide = async (axis, id) => (await guides()).find(g => g.axis === axis && (!id || g.id === id));
const settle = () => page.waitForTimeout(35);
const screenshot = name => page.screenshot({ path: path.join(output, `${label}-${name}.png`), fullPage: true });
const shift = async held => { if (held === shiftHeld) return; if (held) await page.keyboard.down('Shift'); else await page.keyboard.up('Shift'); shiftHeld = held; await settle(); };
const rawPoint = async (axis, raw, orthogonal) => {
  const stage = await page.locator('.stage').boundingBox(), p = (await state()).project, viewport = await page.locator('.previewwrap').boundingBox();
  const visibleX = Math.max(Math.max(stage.x, viewport.x) + 10, Math.min(stage.x + stage.width * .82, Math.min(stage.x + stage.width, viewport.x + viewport.width) - 10));
  const visibleY = Math.max(Math.max(stage.y, viewport.y) + 10, Math.min(stage.y + stage.height * .17, Math.min(stage.y + stage.height, viewport.y + viewport.height) - 10));
  return axis === 'x' ? { x: stage.x + raw / p.width * stage.width, y: orthogonal ?? visibleY } : { x: orthogonal ?? visibleX, y: stage.y + raw / p.height * stage.height };
};
const begin = async (axis, creating = false, held = false) => {
  await shift(held);
  const stage = await page.locator('.stage').boundingBox();
  let start;
  if (creating) {
    const ruler = await page.locator(`.canvas-ruler.${axis === 'x' ? 'vertical' : 'horizontal'}`).boundingBox();
    // Pinned rulers span the viewport, while the frame may be larger or panned.
    // Choose a real hit point in the visible overlap, never outside the strip.
    const visibleX = (Math.max(ruler.x, stage.x) + Math.min(ruler.x + ruler.width, stage.x + stage.width)) / 2;
    const visibleY = (Math.max(ruler.y, stage.y) + Math.min(ruler.y + ruler.height, stage.y + stage.height)) / 2;
    start = axis === 'x' ? { x: ruler.x + ruler.width / 2, y: visibleY } : { x: visibleX, y: ruler.y + ruler.height / 2 };
  } else start = await rawPoint(axis, (await guide(axis)).position);
  const priorIds = (await guides()).map(g => g.id);
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  active = { axis, start, priorIds, creating, id: creating ? undefined : (await guide(axis)).id, pointerId: await page.evaluate(() => window.__guideQaPointerId) };
  return active;
};
const move = async raw => {
  const point = await rawPoint(active.axis, raw, active.axis === 'x' ? active.start.y : active.start.x);
  await page.mouse.move(point.x, point.y, { steps: 7 }); await settle();
  if (!active.id && active.creating) active.id = (await guides()).find(g => !active.priorIds.includes(g.id))?.id;
  return active.id ? guide(active.axis, active.id) : undefined;
};
const position = async (name, expected) => {
  const found = await guide(active.axis, active.id);
  check(name, found?.position === expected, { expected, guide: found });
};
const noExtraHistory = async (name, expected) => check(name, (await state()).past === expected, { expected, actual: (await state()).past });
const release = async (name = 'pointerup removes Shift listeners') => {
  await page.mouse.up(); await settle();
  const before = await projectJSON(), past = (await state()).past;
  await shift(false); await shift(true); await shift(false);
  check(name, await projectJSON() === before && (await state()).past === past);
};
const history = async (name, before, past, after, restore = false) => {
  check(`${name} has one history entry`, (await state()).past === past + 1, { before: past, after: (await state()).past });
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await settle(); check(`${name} exact Undo`, await projectJSON() === before);
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); await settle(); check(`${name} exact Redo`, await projectJSON() === after);
  if (restore) { await page.getByRole('button', { name: 'Undo', exact: true }).click(); await settle(); }
};
const visualGuidePosition = async (axis, id) => {
  const stage = await page.locator('.stage').boundingBox(), p = (await state()).project, g = await guide(axis, id);
  const box = await page.getByRole('button', { name: `${axis === 'x' ? 'Vertical' : 'Horizontal'} guide at ${Math.round(g.position)} pixels`, exact: true }).boundingBox();
  const expected = axis === 'x' ? stage.x + g.position / p.width * stage.width : stage.y + g.position / p.height * stage.height;
  const actual = (axis === 'x' ? box.x : box.y) + 4;
  check(`${axis} guide screen position maps from project pixels at fitted zoom`, Math.abs(actual - expected) < .6, { guide: g.position, expectedScreen: expected, actualScreen: actual, stage });
};
const basicGestures = async () => {
  for (const axis of ['x', 'y']) {
    const sample = config.samples[axis], before = await projectJSON(), past = (await state()).past, held = axis === 'y';
    await begin(axis, true, held); await move(sample.createRaw);
    await position(`${axis} ruler creation ${held ? 'with Shift already held' : 'plain rounds to one pixel'}`, held ? sample.createStep : Math.round(sample.createRaw));
    if (!held) { await shift(true); await position(`${axis} stationary Shift keydown immediately steps new guide`, sample.createStep); }
    await shift(false); await position(`${axis} stationary Shift keyup immediately restores raw rounded coordinate`, Math.round(sample.createRaw));
    await shift(true); await position(`${axis} stationary Shift can reapply configured interval`, sample.createStep);
    await noExtraHistory(`${axis} modifier changes add no history entries`, past + 1);
    await release(); await visualGuidePosition(axis);
    await history(`${axis} ruler creation gesture`, before, past, await projectJSON());
  }
  await screenshot('created-snapped-guides');
  for (const axis of ['x', 'y']) {
    const sample = config.samples[axis], before = await projectJSON(), past = (await state()).past, held = axis === 'y';
    await begin(axis, false, held); await move(sample.moveRaw);
    await position(`${axis} existing guide ${held ? 'steps with Shift held at mousedown' : 'plain movement rounds one pixel'}`, held ? sample.moveStep : Math.round(sample.moveRaw));
    if (!held) { await shift(true); await position(`${axis} stationary Shift keydown steps existing guide`, sample.moveStep); }
    await shift(false); await position(`${axis} stationary keyup restores existing guide raw coordinate`, Math.round(sample.moveRaw));
    await shift(true); await position(`${axis} stationary keydown reapplies step without pointer movement`, sample.moveStep);
    await noExtraHistory(`${axis} existing modifier changes add no history`, past + 1);
    await release(); await visualGuidePosition(axis);
    await history(`${axis} existing guide movement`, before, past, await projectJSON());
  }
  const c = (await state()).project.editorCanvas;
  check('Shift stepping works with hidden grid, master snap off and grid snap off', !c.grid.visible && !c.snap && !c.grid.snap && await page.locator('.canvas-grid').count() === 0, c.grid);
  await screenshot('moved-snapped-guides');
};
const clampGuide = async (axis, raw, expected) => {
  const before = await projectJSON(), past = (await state()).past;
  await begin(axis, false, true); await move(raw); await position(`${axis} nearest interval beyond frame clamps to ${expected}`, expected);
  await release(); check(`${axis} inside raw edge coordinate retains guide`, !!await guide(axis));
  await history(`${axis} frame-clamped movement`, before, past, await projectJSON(), true);
};
const deleteOutside = async axis => {
  const before = await projectJSON(), past = (await state()).past;
  await begin(axis, false, true); const id = active.id; await move(-.75);
  await position(`${axis} raw outside can still display an inside Shift step before release`, axis === 'x' ? 20 : 0);
  await screenshot(`${axis}-raw-outside-before-delete`); await release();
  check(`${axis} raw outside removes guide on pointerup despite inside snapped position`, !await guide(axis, id));
  await history(`${axis} outside deletion`, before, past, await projectJSON(), true);
};
const cancelledCreation = async axis => {
  const before = await projectJSON(), past = (await state()).past, count = (await guides()).length;
  await begin(axis, true, true); await move(config.samples[axis].createRaw);
  check(`${axis} entering ruler gesture creates exactly one provisional guide`, (await guides()).length === count + 1);
  await move(-.75); await release();
  check(`${axis} new guide dragged outside is removed without changing existing guides`, await projectJSON() === before && (await guides()).length === count);
  await history(`${axis} creation then outside removal`, before, past, await projectJSON());
  const neverBefore = await projectJSON(), neverPast = (await state()).past;
  await begin(axis, true, true); await move(-.75); await shift(false); await shift(true); await release();
  check(`${axis} never-entered ruler gesture changes neither project nor history`, await projectJSON() === neverBefore && (await state()).past === neverPast);
};
const cancellationAndForeignPointer = async () => {
  const before = await projectJSON(), past = (await state()).past;
  await begin('x', false, false); await move(349.6);
  const snapshot = await projectJSON(), pointerId = active.pointerId, point = await rawPoint('x', 750, active.start.y);
  for (const type of ['pointermove', 'pointerup', 'pointercancel']) {
    await page.locator('body').dispatchEvent(type, { bubbles: true, pointerId: pointerId + 77, isPrimary: false, pointerType: 'touch', clientX: point.x, clientY: point.y, shiftKey: true }); await settle();
    check(`Synthetic foreign ${type} cannot mutate active guide`, await projectJSON() === snapshot, { activePointer: pointerId, foreignPointer: pointerId + 77 });
  }
  await shift(true); await position('Foreign pointer end events did not end real gesture', 380);
  await page.locator('body').dispatchEvent('pointercancel', { bubbles: true, pointerId, isPrimary: true, pointerType: 'mouse' }); await settle();
  const cancelled = await projectJSON(), cancelPast = (await state()).past;
  await shift(false); await shift(true); await move(700); await shift(false); await page.mouse.up(); await settle();
  check('Matching pointercancel cleans up pointer and stationary Shift listeners', await projectJSON() === cancelled && (await state()).past === cancelPast);
  await history('Cancelled guide movement', before, past, await projectJSON(), true);
};
const objectAltRegression = async () => {
  await page.locator('.canvas-toolbar').getByRole('button', { name: 'Snap', exact: true }).click();
  for (const alt of [false, true]) {
    const before = await projectJSON(), past = (await state()).past, s = await state(), item = s.project.clips.find(c => c.id === 'title'), stage = await page.locator('.stage').boundingBox(), box = await page.locator('.canvas-selection').boundingBox();
    const start = { x: box.x + box.width * .4, y: box.y + box.height * .6 };
    if (alt) await page.keyboard.down('Alt');
    await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(start.x + 394 / s.project.width * stage.width, start.y, { steps: 8 }); await settle();
    const moved = (await state()).project.clips.find(c => c.id === 'title').overlay;
    check(`${alt ? 'Alt object drag still bypasses guides' : 'Ordinary object drag still snaps to guide'} after Shift guide gestures`, Math.abs(moved.x - (alt ? 494 : 500)) < .001 && await page.locator('.canvas-snap-line').count() === (alt ? 0 : 1), { original: item.overlay, after: moved });
    await screenshot(alt ? 'title-alt-bypass' : 'title-guide-snap');
    await page.mouse.up(); if (alt) await page.keyboard.up('Alt'); await settle();
    await history(`${alt ? 'Alt' : 'Snapped'} object drag regression`, before, past, await projectJSON(), true);
  }
};
const previewView = () => page.getByRole('region', { name: 'Video preview', exact: true }).evaluate(node => ({ zoom: Number(node.dataset.previewZoom), x: Number(node.dataset.previewPanX), y: Number(node.dataset.previewPanY) }));
const viewInvariant = async (name, before) => {
  const now = await state();
  check(name, canonical(now.project) === canonical(before.project) && now.past === before.past && now.future === before.future && now.selectedClipId === before.selectedClipId && now.playing === before.playing && now.playhead === before.playhead, { before: { past: before.past, future: before.future, playing: before.playing, playhead: before.playhead }, after: { past: now.past, future: now.future, playing: now.playing, playhead: now.playhead } });
};
const navigationPhase = async () => {
  const viewport = page.getByRole('region', { name: 'Video preview', exact: true }), initialState = await state(), fitStage = await page.locator('.stage').boundingBox();
  await page.getByRole('button', { name: 'Zoom preview in', exact: true }).click(); await settle();
  check('Navigation zoom-in button updates real frame scale and accessible percentage', Math.abs((await previewView()).zoom - 1.25) < 1e-9 && await page.locator('output[aria-label="Preview zoom"]').innerText() === '125%' && (await page.locator('.stage').boundingBox()).width > fitStage.width * 1.24);
  await page.getByRole('button', { name: 'Zoom preview out', exact: true }).click(); await settle();
  check('Navigation zoom-out button returns actual view to Fit scale', Math.abs((await previewView()).zoom - 1) < 1e-9);
  await viewInvariant('Preview zoom buttons leave project, playback and history unchanged', initialState);
  await page.mouse.move(fitStage.x + fitStage.width / 2, fitStage.y + fitStage.height / 2); await page.mouse.wheel(0, -270);
  await page.waitForFunction(() => Number(document.querySelector('[aria-label="Video preview"]').dataset.previewZoom) > 1.3); await settle();
  const zoomed = await page.locator('.stage').boundingBox(), zoomView = await previewView();
  check('Real wheel event zooms actual frame layout', zoomView.zoom > 1.4 && Math.abs(zoomed.width / fitStage.width - zoomView.zoom) < .01 && Math.abs(zoomed.height / fitStage.height - zoomView.zoom) < .01, { fitStage, zoomed, view: zoomView });
  await viewInvariant('Wheel zoom is view-only', initialState);
  for (const axis of ['x', 'y']) {
    const sample = config.samples[axis], before = await projectJSON(), past = (await state()).past;
    await begin(axis, true, false); await move(sample.createRaw);
    await position(`Center-zoom pinned ${axis} ruler creates guide without panning`, Math.round(sample.createRaw));
    await shift(true); await position(`Center-zoom ${axis} stationary Shift steps new guide`, sample.createStep);
    await shift(false); await position(`Center-zoom ${axis} stationary keyup restores raw coordinate`, Math.round(sample.createRaw));
    await shift(true); await screenshot(`center-zoom-${axis}-guide`); await release(); await visualGuidePosition(axis, active.id);
    await history(`Center-zoom ${axis} pinned ruler creation`, before, past, await projectJSON(), true);
  }
  const navigationBaseline = await state();
  // Deliberately pan after proving creation from the centered zoomed view.
  const area = await viewport.boundingBox(), dx = area.x + 60 - zoomed.x, dy = area.y + 60 - zoomed.y;
  const panStart = { x: area.x + area.width / 2, y: area.y + area.height * .45 };
  await page.mouse.move(panStart.x, panStart.y); await page.mouse.down({ button: 'middle' }); await page.mouse.move(panStart.x + dx, panStart.y + dy, { steps: 8 }); await page.mouse.up({ button: 'middle' }); await settle();
  const middlePanned = await page.locator('.stage').boundingBox(), middleView = await previewView();
  check('Middle-button drag pans the actual frame by screen-pixel delta', Math.abs(middlePanned.x - zoomed.x - dx) < .1 && Math.abs(middlePanned.y - zoomed.y - dy) < .1 && Math.abs(middleView.x - zoomView.x - dx) < .1 && Math.abs(middleView.y - zoomView.y - dy) < .1, { expectedDelta: { x: dx, y: dy }, before: zoomed, after: middlePanned, view: middleView });
  await viewInvariant('Middle pan changes no guide, clip, playback or history', navigationBaseline);
  await viewport.focus();
  const existing = await guide('x'), p = (await state()).project;
  const spaceStart = { x: middlePanned.x + existing.position / p.width * middlePanned.width, y: middlePanned.y + 55 };
  await page.mouse.move(spaceStart.x, spaceStart.y); await page.keyboard.down('Space'); await page.mouse.down(); await page.mouse.move(spaceStart.x + 25, spaceStart.y + 18, { steps: 8 }); await page.mouse.up(); await page.keyboard.up('Space'); await settle();
  const spacePanned = await page.locator('.stage').boundingBox();
  check('Space-left drag over an existing guide pans instead of editing it', Math.abs(spacePanned.x - middlePanned.x - 25) < .1 && Math.abs(spacePanned.y - middlePanned.y - 18) < .1, { before: middlePanned, after: spacePanned });
  await viewInvariant('Space pan over guide preserves project and does not toggle playback', navigationBaseline);
  const rulerX = await page.locator('.canvas-ruler.vertical').boundingBox(), rulerY = await page.locator('.canvas-ruler.horizontal').boundingBox();
  check('Both pinned rulers remain reachable inside viewport after panning', rulerX.x >= area.x && rulerX.x + rulerX.width <= area.x + area.width && rulerY.y >= area.y && rulerY.y + rulerY.height <= area.y + area.height, { rulerX, rulerY, area });
  await screenshot('zoom-pan-before-guides');
  for (const axis of ['x', 'y']) {
    const sample = config.samples[axis], before = await projectJSON(), past = (await state()).past;
    await begin(axis, true, false); await move(sample.createRaw);
    await position(`Zoomed/panned ${axis} ruler creation maps plain project pixels`, Math.round(sample.createRaw));
    await shift(true); await position(`Zoomed/panned ${axis} stationary Shift quantizes new guide`, sample.createStep);
    await shift(false); await position(`Zoomed/panned ${axis} stationary keyup restores new guide raw coordinate`, Math.round(sample.createRaw));
    await shift(true); await release(); await visualGuidePosition(axis, active.id);
    await history(`Zoomed/panned ${axis} guide creation`, before, past, await projectJSON());
  }
  for (const axis of ['x', 'y']) {
    const raw = config.default ? axis === 'x' ? 647.4 : 647.6 : axis === 'x' ? 619.4 : 682.6;
    const stepped = config.default ? 600 : axis === 'x' ? 620 : 705;
    const before = await projectJSON(), past = (await state()).past;
    await begin(axis, false, true); await move(raw); await position(`Zoomed/panned ${axis} existing guide steps in project pixels`, stepped);
    await shift(false); await position(`Zoomed/panned ${axis} stationary keyup recomputes moved guide`, Math.round(raw));
    await shift(true); await position(`Zoomed/panned ${axis} stationary keydown restores moved guide interval`, stepped);
    await release(); await visualGuidePosition(axis, active.id);
    await history(`Zoomed/panned ${axis} guide movement`, before, past, await projectJSON());
  }
  const edited = await state();
  const content = project => ({ ...project, editorCanvas: { ...project.editorCanvas, guides: undefined } });
  check('Zoomed/panned guide edits preserve every non-guide project property', canonical(content(initialState.project)) === canonical(content(edited.project)));
  await screenshot('zoom-pan-snapped-guides');
  await page.getByRole('button', { name: 'Fit preview', exact: true }).click(); await settle();
  const fitted = await previewView(), actualFit = await page.locator('.stage').boundingBox();
  check('Fit resets zoom and pan and restores fitted frame geometry', fitted.zoom === 1 && fitted.x === 0 && fitted.y === 0 && Math.abs(actualFit.width - fitStage.width) < .1 && Math.abs(actualFit.height - fitStage.height) < .1 && Math.abs(actualFit.x - fitStage.x) < .1 && Math.abs(actualFit.y - fitStage.y) < .1, { view: fitted, before: fitStage, after: actualFit });
  await viewInvariant('Fit is view-only and retains all guide edits/history', edited);
  await screenshot('fit-after-navigation');
};

const scenarios = [
  { name: 'landscape-default-1480', width: 1920, height: 1080, viewport: { width: 1480, height: 960 }, grid: { spacingX: 100, spacingY: 100, originX: 0, originY: 0 }, samples: { x: { createRaw: 237.6, createStep: 200, moveRaw: 487.4, moveStep: 500 }, y: { createRaw: 338.6, createStep: 300, moveRaw: 487.6, moveStep: 500 } }, default: true },
  { name: 'landscape-custom-1480', width: 1920, height: 1080, viewport: { width: 1480, height: 960 }, full: true },
  { name: 'landscape-custom-1150', width: 1920, height: 1080, viewport: { width: 1150, height: 760 } },
  { name: 'portrait-custom-1480', width: 1080, height: 1920, viewport: { width: 1480, height: 960 } },
].map(c => ({ grid: { spacingX: 120, spacingY: 90, originX: 20, originY: -15 }, samples: { x: { createRaw: 349.6, createStep: 380, moveRaw: 463.4, moveStep: 500 }, y: { createRaw: 238.6, createStep: 255, moveRaw: 502.6, moveStep: 525 } }, ...c }));
const server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort'], { cwd: root, windowsHide: true, stdio: 'ignore' });
try {
  let ready = false;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://localhost:${port}`)).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 250)); }
  if (!ready) throw new Error('Own Vite server did not become ready');
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  for (config of scenarios) {
    label = config.name; shiftHeld = false;
    const context = await browser.newContext({ viewport: config.viewport }); page = await context.newPage(); page.setDefaultTimeout(5000);
    environments.push({ name: label, browser: 'Microsoft Edge', version: browser.version(), headless: true, viewport: config.viewport, project: { width: config.width, height: config.height }, grid: config.grid });
    page.on('pageerror', e => errors.push({ case: label, error: String(e) }));
    page.on('console', m => { if (/\[vite\]|Error|Failed/i.test(m.text())) consoleMessages.push({ case: label, type: m.type(), text: m.text() }); });
    page.on('request', r => { if (!/^(?:http:\/\/localhost:5194|data:|blob:)/.test(r.url())) externalRequests.push(r.url()); });
    try {
      await page.goto(`http://localhost:${port}`); await page.waitForFunction(() => !!window.cutwrightStore); await page.waitForTimeout(200);
      const overlay = { kind: 'title', text: 'Shift guide QA', fontFamily: 'Arial', fontSize: 42, fontWeight: 700, color: '#FFFFFF', x: 100, y: config.height * .72, blockWidth: 300, lineHeight: 50, align: 'left' };
      const fixture = { version: 1, name: `Guide Shift · ${label}`, width: config.width, height: config.height, fps: 30, media: [{ id: 'bg', name: 'Local background', kind: 'image', src: 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${config.width}" height="${config.height}"><rect width="100%" height="100%" fill="#142D3F"/></svg>`), duration: 8, width: config.width, height: config.height, color: '#244966' }, { id: 'title', name: 'Guide title', kind: 'image', src: '', duration: 8, color: '#9370AA', overlay }], clips: [{ id: 'bg', mediaId: 'bg', name: 'Local background', trackId: 'v1', start: 0, duration: 8, offset: 0, color: '#244966' }, { id: 'title', mediaId: 'title', name: 'Guide title', trackId: 'v2', start: 0, duration: 8, offset: 0, color: '#9370AA', overlay }], transitions: [], subtitles: [], customTransitions: [], trackSettings: {}, editorCanvas: { rulers: true, guidesVisible: true, guidesLocked: false, snap: false, grid: { visible: false, snap: false, ...config.grid }, guides: [] } };
      await page.evaluate(project => {
        window.cutwrightStore.setState({ project, playhead: 1, playing: false, selectedClipId: 'title', selectedSubId: null, selectedTransitionId: null, past: [], future: [], pxPerSec: 48, snapEnabled: true, rippleEnabled: false });
        document.addEventListener('pointerdown', e => { window.__guideQaPointerId = e.pointerId; }, { capture: true });
      }, fixture); await settle();
      const stage = await page.locator('.stage').boundingBox(), workspace = await page.locator('.previewwrap').boundingBox();
      check('Fitted frame has real project ratio and remains in workspace', Math.abs(stage.width / stage.height - config.width / config.height) < .005 && stage.x >= workspace.x && stage.y >= workspace.y && stage.x + stage.width <= workspace.x + workspace.width + 1 && stage.y + stage.height <= workspace.y + workspace.height + 1, { stage, workspace });
      if (config.default) {
        await page.locator('.canvas-ruler.vertical').hover({ position: { x: 8, y: 25 } }); await page.getByRole('tooltip').waitFor({ state: 'visible' });
        const text = await page.getByRole('tooltip').innerText(); check('Themed ruler tooltip explains Shift grid stepping', /Shift/i.test(text) && /step|grid|100/i.test(text), text); await screenshot('shift-step-tooltip');
      }
      await basicGestures();
      if (config.default) { await clampGuide('y', 1079.3, 1080); await objectAltRegression(); }
      if (config.full) {
        await clampGuide('x', 1919.3, 1920); await clampGuide('y', .7, 0);
        for (const axis of ['x', 'y']) { await deleteOutside(axis); await cancelledCreation(axis); }
        await cancellationAndForeignPointer();
      }
      if (withNavigation) await navigationPhase();
      await screenshot('final-editor');
    } catch (error) { check('UI test runtime', false, String(error?.stack ?? error)); await screenshot('failure').catch(() => {}); }
    finally { await context.close(); }
  }
  label = ''; check('No uncaught browser errors', errors.length === 0, errors); check('No external editor requests', externalRequests.length === 0, [...new Set(externalRequests)]);
} catch (error) { label = ''; check('Guide test launch', false, String(error?.stack ?? error)); }
finally {
  label = ''; const sourceAfter = hashes(), changed = [...new Set([...Object.keys(sourceBefore), ...Object.keys(sourceAfter)])].filter(file => sourceBefore[file] !== sourceAfter[file]);
  check('Owned CanvasAids, canvasGeometry and UI test hashes stayed stable', owned.every(file => sourceBefore[file] === sourceAfter[file]), changed.filter(file => owned.includes(file)));
  check('All source/index/package state stayed unchanged', changed.length === 0, changed);
  await browser?.close(); server.kill();
  writeFileSync(path.join(output, 'report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), phases: { guides: true, navigation: withNavigation }, environments, sourceBefore, sourceAfter, results, errors, consoleMessages, externalRequests: [...new Set(externalRequests)], limitations: ['Foreign pointer-id and pointercancel cases use synthetic DOM PointerEvents; real mouse, keyboard and all ordinary edits use browser input.', 'Source Edge UI only; no native/compiled release or export claim.'] }, null, 2));
  console.log(`Evidence: ${output}`);
}
