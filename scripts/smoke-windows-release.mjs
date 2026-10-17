import { _electron } from 'playwright-core';
import { mkdtempSync, existsSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const folder = mkdtempSync(path.join(tmpdir(), 'cutwright-release-smoke-'));
const installer = path.resolve('release', `CutWright-Setup-${version}.exe`);
const unpacked = process.argv.includes('--unpacked');
const installed = unpacked ? path.resolve('release/win-unpacked') : path.join(folder, 'installed');
if (!unpacked) {
  const setup = spawnSync(installer, ['/S', `/D=${installed}`], { timeout: 120_000, windowsHide: true });
  assert.equal(setup.status, 0, `Silent installer failed: ${setup.error || setup.status}`);
}
const executable = path.join(installed, 'CutWright.exe');
assert(existsSync(executable), 'Installed executable is missing.');
const ffmpeg = path.join(installed, 'resources', 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
const fixture = path.join(folder, 'release-fixture.mp4'), output = path.join(folder, 'export.mp4');
const generate = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', fixture], { timeout: 30_000, windowsHide: true });
assert.equal(generate.status, 0, 'Installed Windows FFmpeg could not generate the test media.');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const electron = await _electron.launch({ executablePath: executable, args: ['--disable-gpu', '--lang=en-US', `--user-data-dir=${path.join(folder, 'profile')}`], env, timeout: 60_000 });
try {
  assert.equal(await electron.evaluate(({ app }) => app.getVersion()), version);
  await electron.evaluate(({ dialog }, files) => {
    dialog.showOpenDialog = async (...args) => {
      dialog.showOpenDialog.lastOptions = args.at(-1);
      return { canceled: false, filePaths: [files.fixture] };
    };
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: files.output });
  }, { fixture, output });
  const page = await electron.firstWindow();
  await page.locator('.brand-version').waitFor();
  assert.equal(await page.locator('.brand-version').innerText(), version);
  const chooseLanguage = async (name, code) => {
    await page.locator('[data-language-toggle]').click();
    await page.getByRole('menuitemradio', { name, exact: true }).click();
    await page.waitForFunction(code => document.documentElement.lang === code, code);
  };
  await chooseLanguage('English', 'en');
  const projectName = await page.locator('.projname').inputValue();
  for (const [name, code] of [['Deutsch', 'de'], ['Українська', 'uk'], ['English', 'en']]) {
    await chooseLanguage(name, code);
    assert.equal(await page.locator('.projname').inputValue(), projectName, 'Changing language renamed project content.');
  }
  assert.equal(await page.getByRole('button', { name: 'Agent', exact: true }).count(), 1);
  assert.equal(await page.locator('.topbar button[aria-label="Agent connection"]').count(), 0);
  await page.getByRole('button', { name: 'Appearance: automatic. Switch to light.', exact: true }).click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  await page.getByRole('button', { name: 'Appearance: light. Switch to dark.', exact: true }).click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await chooseLanguage('Deutsch', 'de');
  await page.getByRole('button', { name: 'Importieren', exact: true }).click();
  await page.getByText('release-fixture.mp4', { exact: true }).first().waitFor({ timeout: 30_000 });
  assert.equal(await electron.evaluate(({ dialog }) => dialog.showOpenDialog.lastOptions.filters[0].name), 'Medien', 'Native media picker did not follow the selected language.');
  await chooseLanguage('English', 'en');
  await page.getByText('release-fixture.mp4', { exact: true }).first().click({ timeout: 30_000 });
  const viewport = page.getByRole('region', { name: 'Video preview', exact: true });
  const frame = await viewport.boundingBox();
  const x = frame.x + frame.width / 2, y = frame.y + frame.height / 2;
  const originalOffset = await page.getByRole('spinbutton', { name: 'Horizontal offset', exact: true }).inputValue();
  const expectPan = async (dx, dy) => {
    // CDP input acknowledgement can precede React's rendered update on the service runner.
    await page.waitForFunction(({ dx, dy }) => {
      const view = document.querySelector('[data-preview-pan-x]');
      return Math.abs(Number(view?.getAttribute('data-preview-pan-x')) - dx) < 0.1 && Math.abs(Number(view?.getAttribute('data-preview-pan-y')) - dy) < 0.1;
    }, { dx, dy }, { timeout: 5000 });
    assert(Math.abs(Number(await viewport.getAttribute('data-preview-pan-x')) - dx) < 0.1, 'Preview horizontal pan differs from the drag.');
    assert(Math.abs(Number(await viewport.getAttribute('data-preview-pan-y')) - dy) < 0.1, 'Preview vertical pan differs from the drag.');
  };
  await page.mouse.move(x, y); await page.mouse.down({ button: 'right' }); await page.mouse.move(x + 50, y + 30, { steps: 6 }); await page.mouse.up({ button: 'right' });
  await expectPan(50, 30);
  assert.equal(await page.getByRole('spinbutton', { name: 'Horizontal offset', exact: true }).inputValue(), originalOffset, 'Panning changed the clip transform.');
  await page.getByRole('button', { name: 'Fit preview', exact: true }).click();
  assert.equal(Number(await viewport.getAttribute('data-preview-pan-x')), 0);
  await page.getByRole('button', { name: 'Pan preview', exact: true }).click();
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 40, y - 20, { steps: 6 }); await page.mouse.up();
  await expectPan(40, -20);
  await page.getByRole('button', { name: 'Fit preview', exact: true }).click();
  await page.getByRole('button', { name: 'Pan preview', exact: true }).click();
  await page.getByRole('button', { name: 'Keyboard shortcuts', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search shortcuts', exact: true }).fill('Next frame');
  const binding = page.getByRole('button', { name: /^Change Next frame shortcut:/ });
  await binding.click(); await binding.press('F8');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Fit preview', exact: true }).press('Home');
  await page.getByRole('button', { name: 'Fit preview', exact: true }).press('F8');
  await page.waitForFunction(() => !document.querySelector('.timecode').textContent.trim().startsWith('00:00.00'));
  assert((await page.getByRole('button', { name: 'Next frame', exact: true }).getAttribute('data-tooltip')).includes('F8'));
  await page.getByRole('button', { name: 'Keyboard shortcuts', exact: true }).click();
  await page.getByRole('button', { name: 'Restore all defaults', exact: true }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  const videoClip = page.locator('.track[data-track="v1"] .clip');
  const audioClip = page.locator('.track[data-track="a1"] .clip');
  assert.equal(await page.locator('.clip[data-link-group]').count(), 2, 'Video with audio must create two linked blocks.');
  await videoClip.click();
  await page.getByRole('button', { name: 'Fit preview', exact: true }).press('Home');
  for (let frame = 0; frame < 6; frame++) await page.getByRole('button', { name: 'Fit preview', exact: true }).press('ArrowRight');
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  assert.equal(await page.locator('.clip[data-link-group]').count(), 4, 'Splitting must cut both linked blocks.');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.equal(await page.locator('.clip[data-link-group]').count(), 2);
  await videoClip.click({button:'right'});
  await page.getByRole('menuitem', {name:'Detach audio',exact:true}).click();
  assert.equal(await page.locator('.clip[data-link-group]').count(), 0);
  const pictureLeft = await videoClip.evaluate(el=>el.style.left);
  await audioClip.click();
  await page.getByRole('spinbutton', {name:'Start',exact:true}).fill('0.5');
  await page.getByRole('spinbutton', {name:'Start',exact:true}).press('Enter');
  assert.equal(await videoClip.evaluate(el=>el.style.left), pictureLeft, 'Detached sound movement changed the video.');
  assert.notEqual(await audioClip.evaluate(el=>el.style.left), pictureLeft, 'Detached audio did not move.');
  await page.getByRole('button', {name:'Undo',exact:true}).click();
  await page.getByRole('button', {name:'Delete',exact:true}).click();
  assert.equal(await page.locator('.clip').count(), 1, 'Deleting detached audio must keep the picture.');
  const render = async () => {
    if (existsSync(output)) unlinkSync(output);
    await page.locator('#export-btn').click();
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && (!existsSync(output) || statSync(output).size < 1000 || await page.locator('#export-btn').innerText().then(text => text.includes('Cancel')))) await new Promise(resolve => setTimeout(resolve, 1000));
    assert(existsSync(output) && statSync(output).size > 1000, 'Native export did not finish.');
  };
  await render();
  const silent = spawnSync(ffmpeg, ['-v','error','-i',output,'-map','0:a','-f','f32le','-acodec','pcm_f32le','-'], {timeout:30000,windowsHide:true});
  assert.equal(silent.status,0,'Cannot decode the silent export audio.');
  let peak=0; for(let i=0;i<silent.stdout.length;i+=4)peak=Math.max(peak,Math.abs(silent.stdout.readFloatLE(i)));
  assert(peak<1e-6,`Deleted audio leaked into export (${peak}).`);
  await page.getByRole('button', {name:'Undo',exact:true}).click();
  assert.equal(await page.locator('.clip').count(),2);
  await page.getByRole('button', {name:'Undo',exact:true}).click();
  assert.equal(await page.locator('.clip[data-link-group]').count(),2,'Undo must restore the linked pair.');
  await render();
  const decode = spawnSync(ffmpeg, ['-v', 'error', '-i', output, '-f', 'null', '-'], { timeout: 30_000, windowsHide: true });
  assert.equal(decode.status, 0, 'The installed app export could not be decoded.');
  await page.screenshot({ path: 'release/smoke-windows.png' });
  writeFileSync('release/smoke-windows.json', JSON.stringify({ version, installed: !unpacked, nativeVersion: true, visibleVersion: true, localizedControls: true, languagePreservesProjectName: true, localizedNativeMediaPicker: true, themeToggle: true, configurableShortcuts: true, rightDragPan: true, handToolPan: true, fitReset: true, clipTransformPreserved: true, imported: true, defaultLinkedTracks:true, linkedSplit:true, detachedAudioEditing:true, deletedAudioSilentExport:true, exported: true, decoded: true, outputBytes: statSync(output).size }, null, 2));
  console.log(`${unpacked ? 'Unpacked' : 'Installed'} Windows ${version}: versions, languages, native picker, shortcuts, appearance, panning, import, native export and full decode passed.`);
} finally { await electron.close(); }
