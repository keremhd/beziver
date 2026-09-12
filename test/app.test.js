'use strict';

// Verifies the browser entry point without a browser: cross-checks every DOM
// id it reaches for against index.html, then drives the real bundle through a
// stub DOM so the whole flow (drop an STL -> depth -> fit -> outline patch ->
// copyable OpenSCAD) actually executes.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
    if (cond) { pass++; console.log('  ok   ' + name + (extra ? '  [' + extra + ']' : '')); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '  [' + extra + ']' : '')); }
};

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const appSrc = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');

console.log('\nDOM id cross-check');
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const used = new Set([
    ...[...appSrc.matchAll(/\bel\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]),
    // canvases are grabbed via ctx2d(), which the el() pattern misses entirely
    ...[...appSrc.matchAll(/\bctx2d\(\s*'([^']+)'/g)].map((m) => m[1]),
    // and number fields are read through num(), a third accessor that this
    // check missed until it let a deleted control keep a live reader
    ...[...appSrc.matchAll(/\bnum\(\s*'([^']+)'/g)].map((m) => m[1]),
]);
const missing = [...used].filter((id) => !htmlIds.has(id));
check('every id app.js uses exists in index.html', missing.length === 0,
    missing.length ? 'missing: ' + missing.join(', ') : used.size + ' ids');

console.log('\nPage shape');
{
    // Exactly one bottom disclosure, and the stage vocabulary must not be in
    // anything the user reads before opening it. It holds no settings any more,
    // so it is not called "Advanced settings".
    const advCount = (html.match(/<summary>Inside the fit/g) || []).length;
    check('one diagnostics disclosure, not two', advCount === 1, advCount + ' found');
    // The prose analyses were written for the rewrite, not for a reader. They
    // are hidden by CSS and only built when ?debug=1 asks for them; the
    // pictures, which explain themselves, are not gated.
    check('the text reports are hidden unless ?debug=1',
        /#diagnostics \.debug-only \{ display: none/.test(html) &&
        ['report-fit', 'report-warp', 'sub-fit', 'sub-warp', 'scad-fit', 'scad-warp']
            .every((id) => new RegExp('class="[^"]*debug-only[^"]*" id="' + id + '"|' +
                                      'id="' + id + '"[^>]*class="[^"]*debug-only').test(html) ||
                   new RegExp('<[^>]*class="[^"]*debug-only[^"]*"[^>]*id="' + id + '"').test(html)));
    check('and the strings are not built when it is off',
        /const DEBUG = /.test(appSrc) &&
        /if \(DEBUG\) el\('report-fit'\)/.test(appSrc) &&
        /if \(DEBUG\) el\('report-warp'\)/.test(appSrc) &&
        /if \(DEBUG\) el\('sub-fit'\)/.test(appSrc));
    check('the diagnostic images are not gated',
        !/debug-only[^>]*id="(input|mask|result|domain)-canvas"/.test(html));
    check('and it is not called a settings pane',
        !/Advanced settings/.test(html) && !/id="advanced"/.test(html));
    const front = html.slice(0, html.indexOf('<details id="diagnostics"'));
    // ids are not copy; strip them before looking for leaked vocabulary
    const prose = front.replace(/\bid="[^"]*"/g, '');
    check('no stage vocabulary in front-of-house copy',
        !/stage\s*[12]|\bwarp\b/i.test(prose),
        (/(stage\s*[12]|\bwarp\b)/i.exec(prose) || ['clean'])[0]);
    check('the detail knob is still visible',
        front.includes('id="detail"') && front.includes('id="detail-info"'));
    check('export sizes are labelled mm',
        /Width \(mm\)/.test(front) && /Depth \(mm\)/.test(front) && /Height \(mm\)/.test(front));
    check('no prose restating what the picture already shows',
        !/Drag to tip the model\.<\/b>|class="hint"/.test(html),
        (/<p class="hint"[^>]*>/.exec(html) || ['clean'])[0]);
    check('but both canvases have an accessible name',
        [...html.matchAll(/<canvas id="(stl|warp)-canvas"[^>]*>/g)].length === 2 &&
        [...html.matchAll(/<canvas id="(?:stl|warp)-canvas"[\s\S]{0,400}?>/g)]
            .every((m) => /aria-label="[^"]*[Dd]rag[^"]*"/.test(m[0])),
        'aria-labels on both previews');
    check('the two reset buttons are named apart',
        /id="reset-object"[^>]*>Reset model</.test(html) &&
        /id="reset-view"[^>]*>Reset view</.test(html));
    check('the drop zone offers both drop and choose',
        /Drop an STL here/.test(front) && /choose a file/.test(front) &&
        /id="stl-upload"/.test(front));
    // Every numeric parameter that became a constant must be gone from BOTH
    // the page and app.js -- a leftover reader on a deleted control is a
    // runtime failure the id cross-check only catches now that num() is in it.
    const gone = ['max-dim', 'basis', 'edge-band', 'edge-weight',
                  'warp-domain', 'warp-corners', 'warp-hoschek', 'warp-lambda',
                  'nx', 'ny', 'lambda', 'warp-degree'];
    const still = gone.filter((id) => htmlIds.has(id));
    check('the hard-coded parameters are no longer controls', still.length === 0,
        still.join(', ') || 'all twelve removed');
    check('and app.js hard-codes them instead',
        /const FIT_BASIS = 'bspline'/.test(appSrc) &&
        /const WARP_DOMAIN = 'harmonic'/.test(appSrc) &&
        /const WARP_LAMBDA = 1e-6/.test(appSrc) &&
        /const FIT_LAMBDA = 1e-4/.test(appSrc) &&
        /function autoResolution/.test(appSrc));
    check('the Detail table is the only source of nx/ny/degree',
        /function detailParams\(\)/.test(appSrc) &&
        /nx: n, ny: n, lambda: FIT_LAMBDA/.test(appSrc) &&
        /degree: detailParams\(\)\.degree/.test(appSrc));
    check('the signed-error canvas is gone, the overlay carries it',
        !htmlIds.has('error-canvas') && !/error-canvas/.test(appSrc) &&
        /function computeErrorField/.test(appSrc));
    check('and so is the lifted-contour chart',
        !htmlIds.has('contour-canvas') && !/contour-canvas|drawContourChart/.test(appSrc));
    check('the diagnostics that earn their place are still there',
        ['input-canvas', 'mask-canvas', 'result-canvas', 'domain-canvas',
         'report-fit', 'report-warp', 'scad-fit', 'scad-warp']
            .every((id) => htmlIds.has(id)));
    check('drag and drop is actually wired',
        /addEventListener\('dragover'/.test(appSrc) && /addEventListener\('drop'/.test(appSrc) &&
        /dataTransfer/.test(appSrc));
}

// ------------------------------------------------------------- stub canvas

class ImageDataStub {
    constructor(w, h, data) {
        this.width = w; this.height = h;
        this.data = data || new Uint8ClampedArray(w * h * 4);
    }
}

function makeCanvas() {
    // clientWidth/Height are what previewSize() measures; a browser would give
    // it the CSS box.
    const canvas = { width: 0, height: 0, title: '', clientWidth: 240, clientHeight: 240 };
    let buf = new Uint8ClampedArray(0);
    const sync = () => {
        const need = canvas.width * canvas.height * 4;
        if (buf.length !== need) buf = new Uint8ClampedArray(need);
    };
    const ctx = {
        canvas,
        fillStyle: '', strokeStyle: '', lineWidth: 1, font: '',
        getImageData(x, y, w, h) { sync(); return new ImageDataStub(w, h, buf.slice()); },
        // Counted: a sliced draw must reach the canvas once, when it is done.
        blits: 0,
        putImageData(img) { sync(); ctx.blits++; buf.set(img.data.subarray(0, buf.length)); },
        createImageData(w, h) { return new ImageDataStub(w, h); },
        clearRect() {}, fillRect() {}, drawImage() {},
        beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, arc() {},
        fill() {}, stroke() {}, fillText() {},
    };
    canvas.getContext = () => ctx;
    return canvas;
}

// default values and initial classes straight out of index.html so the stub
// cannot drift from it
const defaults = {};
for (const m of html.matchAll(/<input\b[^>]*>/g)) {
    const id = /id="([^"]+)"/.exec(m[0]);
    const val = /value="([^"]*)"/.exec(m[0]);
    if (id) defaults[id[1]] = val ? val[1] : '';
}
for (const m of html.matchAll(/<select\b[^>]*id="([^"]+)"[\s\S]*?<option value="([^"]*)"/g)) {
    defaults[m[1]] = m[2];
}
const initialClass = (id) => {
    const tag = new RegExp('<[a-zA-Z]+\\b[^>]*\\bid="' + id + '"[^>]*>').exec(html);
    const cls = tag && /\bclass="([^"]*)"/.exec(tag[0]);
    return cls ? cls[1] : '';
};

const handlers = {};
const elements = {};
for (const id of htmlIds) {
    const isCanvas = /canvas/.test(id) || html.includes(`<canvas id="${id}"`);
    const e = isCanvas ? makeCanvas() : {};
    e.id = id;
    e.value = defaults[id] !== undefined ? defaults[id] : '';
    e.textContent = '';
    e.files = null;
    e.style = {};
    const tag = new RegExp('<input\\b[^>]*id="' + id + '"[^>]*>').exec(html);
    if (tag && /\bchecked\b/.test(tag[0])) e.checked = true;
    e.className = initialClass(id);
    e.select = () => { e.selected = true; };
    e.focus = () => { e.focused = true; };
    // A fixed box, so a pointer position maps to a slider value predictably.
    e.getBoundingClientRect = () => ({ left: 0, top: 100, right: 44, bottom: 400,
                                       width: 44, height: 300 });
    e.attrs = {};
    e.setAttribute = (k, v) => { e.attrs[k] = String(v); };
    e.getAttribute = (k) => (k in e.attrs ? e.attrs[k] : null);
    e.addEventListener = (ev, fn) => {
        handlers[id] = handlers[id] || {};
        (handlers[id][ev] = handlers[id][ev] || []).push(fn);
    };
    elements[id] = e;
}
const winHandlers = {};
globalThis.window = globalThis;
// The prose reports are off unless ?debug=1. This suite asserts on several of
// them, so it runs the bundle with the flag ON, and checks the default-off
// behaviour separately at the end.
globalThis.location = { search: '?debug=1' };
globalThis.self = globalThis;
globalThis.addEventListener = (ev, fn) => {
    (winHandlers[ev] = winHandlers[ev] || []).push(fn);
};
globalThis.FileReader = class {
    readAsArrayBuffer(file) { this.onload({ target: { result: file._buf } }); }
    readAsDataURL(file) { this.onload({ target: { result: 'data:,' } }); }
};
globalThis.ImageData = ImageDataStub;
globalThis.OffscreenCanvas = class { constructor(w, h) { const c = makeCanvas(); c.width = w; c.height = h; return c; } };
globalThis.Blob = class { constructor(parts) { this.text = String(parts[0]); } };
globalThis.URL = { createObjectURL: (b) => { URL._last = b; return 'blob:stub'; }, revokeObjectURL() {} };

const clipboard = { text: null };
Object.defineProperty(globalThis, 'navigator', {
    configurable: true, writable: true,
    value: { clipboard: { writeText(t) { clipboard.text = t; return Promise.resolve(); } } },
});

const downloads = [];
globalThis.document = {
    getElementById(id) {
        if (!elements[id]) throw new Error('unknown element id: ' + id);
        return elements[id];
    },
    createElement(tag) {
        const e = { tag, click() { downloads.push(e); } };
        return e;
    },
};

console.log('\nBundle execution');
let loaded = true;
try {
    require(path.join(root, 'public/script.js'));
} catch (e) {
    loaded = false;
    console.log('       load error: ' + e.message);
}
check('bundle loads and wires listeners', loaded && Object.keys(handlers).length > 0,
    Object.keys(handlers).length + ' elements wired');

console.log('\nBuild handshake');
{
    const htmlBuild = /window\.BEZIVER_BUILD = (\d+)/.exec(html);
    const jsBuild = /^const BUILD = (\d+);/m.exec(appSrc);
    check('index.html declares a build number', !!htmlBuild, htmlBuild && htmlBuild[1]);
    check('app.js declares the same one', !!jsBuild && htmlBuild && jsBuild[1] === htmlBuild[1],
        jsBuild ? 'js ' + jsBuild[1] + ' vs html ' + (htmlBuild || [])[1] : 'none');
    check('a successful load reports readiness',
        globalThis.BEZIVER_READY !== undefined &&
        String(globalThis.BEZIVER_READY) === (htmlBuild || [])[1],
        'READY = ' + globalThis.BEZIVER_READY);
    check('the boot banner speaks plain language',
        !/npm run build|hard-reload|script\.js/i.test(
            html.slice(html.indexOf('__beziverBootError'), html.indexOf('</script>'))));
}

const clickIt = (id) => {
    const hs = (handlers[id] || {}).click || [];
    if (!hs.length) throw new Error('no click handler on ' + id);
    for (const h of hs) h();
};
const fire = (id, ev, arg) => {
    const hs = (handlers[id] || {})[ev] || [];
    if (!hs.length) throw new Error('no ' + ev + ' handler on ' + id);
    for (const h of hs) h(arg);
};
const fireWin = (ev, arg) => { for (const h of winHandlers[ev] || []) h(arg); };
// The two view toggles are real buttons with aria-pressed, so a test drives
// them the way a person does: it clicks, and reads the pressed state back.
const pressed = (id) => elements[id].attrs['aria-pressed'] === 'true';
const setToggle = (id, want) => { if (pressed(id) !== want) clickIt(id); };
// The left preview is now rasterised in app.js rather than copied out of
// depthRender, so the tests look at its pixels rather than trusting that a
// draw call happened.
const pixels = (id) => {
    const c = elements[id];
    return c.getContext().getImageData(0, 0, c.width, c.height).data;
};
const countPixels = (pred, id) => {
    const d = pixels(id || 'stl-canvas');
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (pred(d[i], d[i + 1], d[i + 2])) n++;
    return n;
};
const differing = (a, b) => {
    let n = 0;
    for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i+1] !== b[i+1] || a[i+2] !== b[i+2]) n++;
    return n;
};
// A drag is pointerdown on one canvas, a window pointermove, a window
// pointerup -- pointer events, so one code path serves mouse and finger.
const drag = (id, dx, dy) => {
    fire(id, 'pointerdown', { clientX: 100, clientY: 100 });
    fireWin('pointermove', { clientX: 100 + dx, clientY: 100 + dy });
    fireWin('pointerup', {});
};
// The same drag as a finger makes it, which is the only kind a phone sends.
const touchDrag = (id, dx, dy) => {
    const p = (x, y) => ({ pointerType: 'touch', pointerId: 7, isPrimary: true,
                           clientX: x, clientY: y, preventDefault: () => {} });
    fire(id, 'pointerdown', p(100, 100));
    fireWin('pointermove', p(100 + dx, 100 + dy));
    fireWin('pointerup', p(100 + dx, 100 + dy));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The three rotations are internal, and the assertions that matter are about
// which of them a gesture left ALONE, so the bundle exposes them for the test.
const rot = () => globalThis.BEZIVER_STATE();
// The page's one error formatter, so the test cannot drift from it either.
const { fmtErr } = require(path.join(root, 'src/report.js'));
// The cut-off slider is an absolute height over a fixed per-file range, so a
// test that wants a particular height has to convert one to a slider position
// the same way the app does.
const sliderFor = (level) => {
    const r = rot().meshRadius;
    return String(Math.max(0, Math.min(1000, Math.round(1000 * (level + r) / (2 * r)))));
};
const same = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-12);
const mul = (A, B) => {
    const C = new Array(9).fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
        for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
    return C;
};
// Error magnitudes print with their own unit now, and the unit steps down for
// small values, so a raw number scrape would compare millimetres to microns.
const LAST_RMS = () => {
    const m = /rms ([\d.]+) (mm|\u00b5m)/.exec(elements['report-fit'].textContent);
    return m ? +m[1] / (m[2] === 'mm' ? 1 : 1000) : NaN;
};

// A dome: the well-behaved case.
function domeStl() {
    const K = 34, half = 10, hgt = 3.5;
    const zf = (x, y) => {
        const r = Math.hypot(x, y) / half;
        return r >= 1 ? 0 : hgt * (1 - r * r) * (1 + 0.06 * Math.cos(3 * Math.atan2(y, x)));
    };
    const tris = [];
    for (let j = 0; j < K; j++) {
        for (let i = 0; i < K; i++) {
            const x0 = -half + 2 * half * i / K, x1 = -half + 2 * half * (i + 1) / K;
            const y0 = -half + 2 * half * j / K, y1 = -half + 2 * half * (j + 1) / K;
            tris.push([[x0, y0, zf(x0, y0)], [x1, y0, zf(x1, y0)], [x1, y1, zf(x1, y1)]]);
            tris.push([[x0, y0, zf(x0, y0)], [x1, y1, zf(x1, y1)], [x0, y1, zf(x0, y1)]]);
        }
    }
    return binaryStl(tris);
}

// A field of disconnected pins: the fit still works, but there is no single
// traceable outline to warp onto. This is the pathological case the app must
// absorb without asking the user anything.
function pinsStl() {
    const tris = [];
    const quad = (x0, y0, x1, y1, z) => {
        tris.push([[x0, y0, z], [x1, y0, z], [x1, y1, z]]);
        tris.push([[x0, y0, z], [x1, y1, z], [x0, y1, z]]);
    };
    quad(-10, -10, 10, 10, 0);               // base plate, below the water line
    // Each pin is deliberately smaller than one pixel of the auto-picked
    // raster, so every above-water region is a single isolated pixel and there
    // is no traceable outline at all -- whatever resolution the mesh earns.
    for (let j = 0; j < 26; j++) {
        for (let i = 0; i < 26; i++) {
            const x = -9.75 + 0.75 * i, y = -9.75 + 0.75 * j;
            quad(x, y, x + 0.07, y + 0.07, 1);
        }
    }
    return binaryStl(tris);
}

function binaryStl(tris) {
    const buf = new ArrayBuffer(84 + tris.length * 50);
    const dv = new DataView(buf);
    dv.setUint32(80, tris.length, true);
    let o = 84;
    for (const tr of tris) {
        o += 12;
        for (const v of tr) for (const c of v) { dv.setFloat32(o, c, true); o += 4; }
        o += 2;
    }
    return buf;
}

async function main() {

console.log('\nFirst screen: a drop zone and nothing else');
try {
    check('the working panes start hidden', elements['workspace'].className === 'hidden',
        elements['workspace'].className || '(none)');
    check('the drop zone is not yet the compact bar',
        !/compact/.test(elements['drop-zone'].className));
    check('the water readout is plain language, not 0-1000',
        /^Whole model$/.test(elements['water-info'].textContent) &&
        !/depth/i.test(elements['water-info'].textContent),
        elements['water-info'].textContent);
    check('the error colormap starts off', !pressed('show-errors') &&
        elements['cmap-legend'].textContent === '');
    // Turning it on before there is anything to compare against must say so,
    // not throw.
    setToggle('show-errors', true);
    check('no fit: a note, no bar',
        /no fit/i.test(elements['cmap-legend'].textContent) &&
        elements['cmap-bar'].className === 'hidden',
        elements['cmap-legend'].textContent);
    setToggle('show-errors', false);
    check('and off again clears it', elements['cmap-legend'].textContent === '');
} catch (e) { fail++; console.log('  FAIL first screen threw: ' + e.message); }

console.log('\nDropping an STL runs everything');
try {
    // Actually drop it, rather than reaching for the file input.
    fire('drop-zone', 'drop', {
        preventDefault() {},
        dataTransfer: { files: [{ _buf: domeStl(), name: 'teapot.stl' }] },
    });

    check('both panes become visible', elements['workspace'].className === '',
        elements['workspace'].className || '(none)');
    check('the drop zone collapses to a filename bar',
        elements['drop-zone'].className === 'compact' &&
        elements['drop-text'].textContent === 'teapot.stl',
        elements['drop-text'].textContent);
    check('the STL line is filename + triangle count only',
        /teapot\.stl/.test(elements['stl-info'].textContent) &&
        /triangles/.test(elements['stl-info'].textContent) &&
        !/water at|depth \d+x/.test(elements['stl-info'].textContent),
        elements['stl-info'].textContent);
    check('the pipeline ran with no button pressed',
        /FIT ERROR/.test(elements['report-fit'].textContent) &&
        /END TO END/.test(elements['report-warp'].textContent) &&
        elements['status'].textContent === 'ready', elements['status'].textContent);
    check('errors carry a metric unit',
        /rms [\d.]+ (mm|\u00b5m)/.test(elements['report-fit'].textContent) &&
        !/grey levels|model units/.test(elements['report-fit'].textContent),
        (/  rms[^\n]*/.exec(elements['report-fit'].textContent) || [''])[0].trim());
    check('the file input still works too', typeof (handlers['stl-upload'] || {}).change !== 'undefined');
} catch (e) {
    fail++;
    console.log('  FAIL drop path threw: ' + e.message);
    console.log(e.stack.split('\n').slice(1, 4).join('\n'));
}

console.log('\nOne output, copyable');
try {
    check('there is a single user-facing output',
        /patches = \[/.test(elements['scad-out'].value) &&
        /traced outline/.test(elements['scad-out'].value));
    check('it is the outline patch, not the rectangular fit',
        elements['scad-out'].value === elements['scad-warp'].value &&
        elements['scad-out'].value !== elements['scad-fit'].value);
    check('no fallback note when nothing fell back',
        elements['fallback-note'].className === 'hidden' &&
        elements['fallback-note'].textContent === '');
    check('both textareas still exist for the advanced pane',
        /patches = \[/.test(elements['scad-fit'].value) &&
        /patches = \[/.test(elements['scad-warp'].value));

    clipboard.text = null;
    clickIt('copy-scad');
    await sleep(10);
    check('copy writes the code to the clipboard', clipboard.text === elements['scad-out'].value,
        clipboard.text ? clipboard.text.length + ' chars' : 'nothing copied');
    check('and confirms it', elements['copy-note'].textContent === 'Copied',
        elements['copy-note'].textContent);

    downloads.length = 0;
    clickIt('download-scad');
    check('download is named after the uploaded file',
        downloads.length === 1 && downloads[0].download === 'teapot.scad',
        downloads.length ? downloads[0].download : 'no download');
    check('and carries the same code', URL._last && URL._last.text === elements['scad-out'].value);

    check('the readout counts patches and control points',
        /^Level \d\/\d \u2014 \d+ patch(es)?, \d+\u00d7\d+ control points$/
            .test(elements['detail-info'].textContent),
        elements['detail-info'].textContent);
    check('the scale states where it came from',
        /from the STL/i.test(elements['size-src'].textContent),
        elements['size-src'].textContent);

    const sx = parseFloat(elements['size-x'].value);
    const sh = parseFloat(elements['size-height'].value);
    check('output size taken from the STL', Math.abs(sx - 20) < 1.5 && sx !== 100,
        'size_x = ' + sx + ' for a 20-unit model');
    check('output height is the real relief', sh > 0 && sh <= 3.5 * 1.06 + 0.01, 'height = ' + sh);
    const sizeLine = (/^size = \[[^\n]*/m.exec(elements['scad-out'].value) || [''])[0];
    check('scad carries those dimensions',
        new RegExp('^size = \\[' + Math.floor(sx)).test(sizeLine), sizeLine);
} catch (e) {
    fail++;
    console.log('  FAIL output moment threw: ' + e.message);
    console.log(e.stack.split('\n').slice(1, 4).join('\n'));
}

console.log('\nWhich canvas you drag is which thing you move');
try {
    const scadBefore = elements['scad-out'].value;
    const fitBefore = elements['report-fit'].textContent;
    const rasterBefore = elements['input-canvas'].width;
    const leftBefore = pixels('stl-canvas').slice();
    const rightBefore = pixels('warp-canvas').slice();
    const objBefore = rot().ObjM, waterBefore = rot().WaterM;

    // RIGHT canvas: the camera, and only the camera.
    drag('warp-canvas', 55, 30);
    check('a right-pane drag changes nothing in flight',
        elements['status'].textContent === 'ready' &&
        elements['report-fit'].textContent === fitBefore,
        elements['status'].textContent);
    await sleep(700);
    check('and nothing runs after the debounce either',
        elements['scad-out'].value === scadBefore &&
        elements['report-fit'].textContent === fitBefore &&
        elements['status'].textContent === 'ready');
    check('the height field was not re-rendered',
        elements['input-canvas'].width === rasterBefore);
    check('the object and the water did not move with the camera',
        same(rot().ObjM, objBefore) && same(rot().WaterM, waterBefore));
    check('but BOTH panes moved: one camera, locked',
        differing(leftBefore, pixels('stl-canvas')) > 500 &&
        differing(rightBefore, pixels('warp-canvas')) > 500,
        differing(leftBefore, pixels('stl-canvas')) + ' / ' +
        differing(rightBefore, pixels('warp-canvas')) + ' px changed');

    // LEFT canvas: the object, and only the object. This IS the pipeline input,
    // because the capture axis is derived from the object's orientation.
    const camPre = rot().CamM, waterPre = rot().WaterM;
    const leftPre = pixels('stl-canvas').slice();
    const scadPre = elements['scad-out'].value;
    drag('stl-canvas', 40, 26);
    check('the model tips in the left pane',
        differing(leftPre, pixels('stl-canvas')) > 500,
        differing(leftPre, pixels('stl-canvas')) + ' px changed');
    // The rejected design moved the camera to hold the cut-off plane still on
    // screen; the viewpoint drifted and the water read as sloshing. Nothing
    // counter-rotates now, so the camera must come out bit-identical.
    check('and the camera did NOT move with it',
        same(rot().CamM, camPre), 'CamM changed');
    check('nor did the water: it is level and it stays level',
        same(rot().WaterM, waterPre));
    check('the object did move', !same(rot().ObjM, objBefore));
    check('a left drag reads as in flight',
        /updating/.test(elements['status'].textContent), elements['status'].textContent);
    await sleep(900);
    check('a left-pane drag DOES change the emitted code',
        elements['scad-out'].value !== scadPre &&
        elements['status'].textContent === 'ready',
        elements['scad-out'].value === scadPre ? 'identical' : 'changed');
    check('and it actually rasterised the mesh',
        countPixels((r, g, b) => r > 90 && r === g && g === b) > 500,
        countPixels((r, g, b) => r > 90 && r === g && g === b) + ' lit px');

    // The capture axis is derived, not dragged: capture space is the water
    // frame seen from the object. A diagonal drag is the case naive Euler
    // add/subtract gets wrong, so check the composition there too.
    drag('stl-canvas', 33, -47);
    let st = rot();
    check('the capture frame is the water frame in the object frame',
        same(st.CapM, mul(st.WaterM, st.ObjM)), 'CapM != WaterM * ObjM');
    check('capture axis is the water normal in object coords',
        same(st.CapM.slice(6), mul(st.WaterM, st.ObjM).slice(6)) &&
        !same(st.ObjM, [1, 0, 0, 0, 1, 0, 0, 0, 1]));
    await sleep(900);
    check('and the pipeline settles', elements['status'].textContent === 'ready');

    // Two resets, one per canvas, each undoing that canvas's own drag.
    const camTilted = rot().CamM;
    const scadTilted = elements['scad-out'].value;
    clickIt('reset-view');
    await sleep(600);
    check('reset view levels the camera and nothing else',
        same(rot().CamM, [1, 0, 0, 0, 1, 0, 0, 0, 1]) &&
        !same(camTilted, rot().CamM) &&
        same(rot().ObjM, st.ObjM) && same(rot().WaterM, st.WaterM));
    check('and leaves the emitted code alone',
        elements['scad-out'].value === scadTilted &&
        elements['status'].textContent === 'ready', elements['status'].textContent);

    // Reset model is the way back to the state the file arrived in, and the
    // cut-off is part of that state: the capture axis is derived from the
    // object, so the rotation and the height aimed at are one act of framing.
    const waterAtLoad = elements['stl-water'].value;
    elements['stl-water'].value = String(Math.min(1000, +waterAtLoad + 180));
    fire('stl-water', 'input');
    await sleep(700);

    clickIt('reset-object');
    check('reset model levels the object and nothing else',
        same(rot().ObjM, [1, 0, 0, 0, 1, 0, 0, 0, 1]) &&
        same(rot().CamM, [1, 0, 0, 0, 1, 0, 0, 0, 1]) &&
        same(rot().WaterM, [1, 0, 0, 0, 1, 0, 0, 0, 1]));
    check('and the cut-off goes back to the loaded one',
        elements['stl-water'].value === waterAtLoad,
        elements['stl-water'].value + ' vs ' + waterAtLoad + ' at load');
    await sleep(900);
    check('and it recomputes, the axis came with it',
        elements['scad-out'].value !== scadTilted &&
        elements['status'].textContent === 'ready',
        elements['scad-out'].value === scadTilted ? 'identical' : 'changed');

    // A click on a button must not also grab the canvas under it.
    const parked = pixels('stl-canvas').slice();
    fireWin('pointermove', { clientX: 400, clientY: 400 });
    check('clicking a reset left no drag in progress',
        differing(parked, pixels('stl-canvas')) === 0 &&
        same(rot().CamM, [1, 0, 0, 0, 1, 0, 0, 0, 1]));
} catch (e) {
    fail++;
    console.log('  FAIL object/water/camera threw: ' + e.message);
    console.log(e.stack.split('\n').slice(1, 4).join('\n'));
}

console.log('\nZoom is a property of the shared camera');
try {
    const wheel = (id, dy, opts) => {
        let stopped = false;
        fire(id, 'wheel', Object.assign({
            deltaY: dy, deltaMode: 0, clientX: 100, clientY: 100,
            preventDefault: () => { stopped = true; },
        }, opts || {}));
        return stopped;
    };

    clickIt('reset-view');
    const base = rot();
    const leftBefore = pixels('stl-canvas').slice();
    const rightBefore = pixels('warp-canvas').slice();
    const scadBefore = elements['scad-out'].value;

    const stopped = wheel('warp-canvas', -120);
    check('a wheel over a canvas zooms in', rot().zoom > base.zoom &&
        rot().viewScale > base.viewScale,
        base.zoom.toFixed(2) + ' -> ' + rot().zoom.toFixed(2));
    // The listener is on the canvas, so the page still scrolls everywhere
    // else -- but over the canvas the gesture must not also scroll the page,
    // which needs { passive: false } as well as the preventDefault call.
    check('and it takes the gesture rather than scrolling the page', stopped);
    check('the wheel listener asks not to be passive',
        /addEventListener\('wheel'(?:(?!addEventListener\()[\s\S])*?\{ passive: false \}/
            .test(appSrc));
    check('no wheel handler is installed on the window',
        !/window\.addEventListener\('wheel'/.test(appSrc) &&
        !(winHandlers['wheel'] || []).length);

    // Zoom is the camera's, and the camera is shared. Owner: "Yes it should
    // zoom in both panes."
    check('both panes move, because they share one camera',
        differing(pixels('stl-canvas'), leftBefore) > 0 &&
        differing(pixels('warp-canvas'), rightBefore) > 0);
    check('it moves neither rotation, and does not re-emit',
        same(rot().ObjM, base.ObjM) && same(rot().CamM, base.CamM) &&
        elements['scad-out'].value === scadBefore &&
        elements['status'].textContent === 'ready',
        elements['status'].textContent);

    // Either canvas: a wheel collides with neither canvas's drag, so making
    // one of them inert would be an arbitrary difference for a gesture with a
    // single shared effect.
    const z1 = rot().zoom;
    wheel('stl-canvas', -120);
    check('the gesture works over the left canvas too', rot().zoom > z1,
        z1.toFixed(2) + ' -> ' + rot().zoom.toFixed(2));

    // A trackpad pinch arrives as a wheel event with ctrlKey set; a two-finger
    // slide arrives as a plain one. Both are zoom.
    const z2 = rot().zoom;
    wheel('warp-canvas', 40, { ctrlKey: true });
    check('trackpad pinch is a ctrlKey wheel, and zooms out',
        rot().zoom < z2, z2.toFixed(2) + ' -> ' + rot().zoom.toFixed(2));

    for (let i = 0; i < 60; i++) wheel('warp-canvas', -120);
    const hi = rot().zoom;
    for (let i = 0; i < 120; i++) wheel('warp-canvas', 120);
    const lo = rot().zoom;
    check('the range is clamped at both ends', hi <= 8 && lo >= 0.4 &&
        hi > 4 && lo < 1, 'reached ' + lo.toFixed(2) + ' .. ' + hi.toFixed(2));

    // Touch pinch: two live pointers and the ratio of their separation.
    const pointer = (id, ev, pid, x, y) =>
        fire(id, ev, { pointerType: 'touch', pointerId: pid, isPrimary: pid === 1,
                       clientX: x, clientY: y, preventDefault: () => {} });
    const z3 = rot().zoom;
    pointer('warp-canvas', 'pointerdown', 1, 100, 100);
    pointer('warp-canvas', 'pointerdown', 2, 140, 100);
    pointer('warp-canvas', 'pointermove', 2, 220, 100);
    check('a two-finger pinch spreads into a zoom', rot().zoom > z3,
        z3.toFixed(2) + ' -> ' + rot().zoom.toFixed(2));
    pointer('warp-canvas', 'pointerup', 1, 100, 100);
    pointer('warp-canvas', 'pointerup', 2, 220, 100);

    // Reset view means "get me back to a known vantage", and being at 6x is
    // not that.
    clickIt('reset-view');
    check('reset view puts the zoom back as well as the camera',
        rot().zoom === 1 && Math.abs(rot().viewScale - base.viewScale) < 1e-9,
        'zoom ' + rot().zoom);

    // A left drag still may not change the scale.
    const scale = rot().viewScale;
    drag('stl-canvas', 26, -14);
    check('and a left drag still does not change the view scale',
        rot().viewScale === scale && rot().zoom === 1);
    await sleep(900);
    clickIt('reset-object');
    await sleep(900);
} catch (e) {
    fail++;
    console.log('  FAIL zoom threw: ' + e.message);
    console.log(e.stack.split('\n').slice(1, 4).join('\n'));
}

console.log('\nThe water is world-static: only the slider moves it');
try {
    // The bug this replaced: the plane was sized from the mesh's bounds along
    // the CURRENT capture axis, so its corners, its size and anything scaled
    // off it moved on every left drag. The plane read as attached to the
    // object, which is the opposite of standing water. So these are assertions
    // on the actual numbers, not on "it still renders".
    const planeSame = (a, b) =>
        same([a.cx, a.cy, a.inner, a.outer, a.ux, a.uy, a.vx, a.vy],
             [b.cx, b.cy, b.inner, b.outer, b.ux, b.uy, b.vx, b.vy]);
    const gridSame = (a, b) =>
        same([a.spacing, a.level, a.n], [b.spacing, b.level, b.n]) &&
        same(a.a, b.a) && same(a.b, b.b);

    elements['stl-water'].value = '470';
    fire('stl-water', 'input');
    await sleep(900);
    const before = rot();
    const readBefore = elements['water-info'].textContent;
    const leftBefore = pixels('stl-canvas').slice();

    drag('stl-canvas', 38, 22);          // tip the object under the water
    const after = rot();
    check('the cut-off height does not move when the object turns',
        after.waterLevel === before.waterLevel,
        before.waterLevel + ' -> ' + after.waterLevel);
    check('nor does the drawn extent of the plane',
        after.planeRadius === before.planeRadius &&
        after.plane.inner === before.plane.inner &&
        after.plane.outer === before.plane.outer,
        before.plane.outer + ' -> ' + after.plane.outer);
    check('nor does the view scale: no apparent zoom',
        after.viewScale === before.viewScale,
        before.viewScale + ' -> ' + after.viewScale);
    check('the plane holds its place, the mesh does not',
        planeSame(after.plane, before.plane) &&
        differing(leftBefore, pixels('stl-canvas')) > 500,
        differing(leftBefore, pixels('stl-canvas')) + ' px of mesh moved');
    check('and the grid on it is fixed in the world',
        gridSame(after.waterGrid, before.waterGrid));

    await sleep(900);
    // The honest consequence of an absolute height: tipping an object in
    // standing water really does change how much of it is under.
    check('but the reported percentage recomputes',
        elements['water-info'].textContent !== readBefore &&
        /^Top \d+\.\d\d mm \u2014 \d+% of the model$/
            .test(elements['water-info'].textContent),
        readBefore + '  ->  ' + elements['water-info'].textContent);
    check('and the height it names is still the slider\u2019s',
        rot().waterLevel === before.waterLevel);

    // A right drag is a projection change and nothing else.
    const camPre = rot();
    drag('warp-canvas', 45, 25);
    check('moving the camera moves no water either',
        rot().waterLevel === camPre.waterLevel &&
        gridSame(rot().waterGrid, camPre.waterGrid) &&
        rot().viewScale === camPre.viewScale);
    check('though it does change where the plane projects to',
        !planeSame(rot().plane, camPre.plane));

    // The one thing that IS allowed to move it.
    const lvlPre = rot().waterLevel, gridPre = rot().waterGrid;
    elements['stl-water'].value = '520';
    fire('stl-water', 'input');
    check('the slider raises the plane, and the grid rides with it',
        rot().waterLevel > lvlPre &&
        Math.abs((rot().waterGrid.level - gridPre.level) -
                 (rot().waterLevel - lvlPre)) < 1e-9 &&
        rot().waterGrid.spacing === gridPre.spacing,
        lvlPre.toFixed(3) + ' -> ' + rot().waterLevel.toFixed(3));
    await sleep(900);

    // A rotation that lifts the whole model clear of the water must arrive as
    // an inline error, not as a thrown exception out of a drag handler.
    elements['stl-water'].value = '1000';
    fire('stl-water', 'input');
    await sleep(900);
    drag('stl-canvas', 20, 12);
    await sleep(900);
    check('an emptied mask fails inline, not by throwing',
        /above the cut-off/i.test(elements['err-water'].textContent) &&
        elements['err-water'].className === 'err',
        elements['err-water'].textContent || '(nothing)');
    clickIt('reset-object');
    await sleep(900);
    elements['stl-water'].value = sliderFor(rot().zRange[0]);   // back to the base
    fire('stl-water', 'input');
    await sleep(900);
} catch (e) {
    fail++;
    console.log('  FAIL water invariance threw: ' + e.message);
    console.log(e.stack.split('\n').slice(1, 4).join('\n'));
}

console.log('\nThe control grid on the result');
try {
    check('it is on by default', pressed('show-grid'));
    const withGrid = pixels('warp-canvas').slice();
    setToggle('show-grid', false);
    const without = pixels('warp-canvas').slice();
    const lo = differing(withGrid, without);
    check('turning it off changes the surface picture', lo > 200, lo + ' px');

    // Moving Detail moves the control net, so it must move the grid.
    setToggle('show-grid', true);
    elements['detail'].value = '8';
    fire('detail', 'input');
    await sleep(900);
    const denseOn = pixels('warp-canvas').slice();
    setToggle('show-grid', false);
    const denseOff = pixels('warp-canvas').slice();
    const hi = differing(denseOn, denseOff);
    check('more detail draws a denser grid', hi > lo, lo + ' -> ' + hi + ' grid px');
    setToggle('show-grid', true);
    elements['detail'].value = '5';
    fire('detail', 'input');
    await sleep(900);
} catch (e) {
    fail++;
    console.log('  FAIL control grid threw: ' + e.message);
    console.log(e.stack.split('\n').slice(1, 4).join('\n'));
}

console.log('\nResolution: the backing store matches what is on screen');
try {
    const L = elements['stl-canvas'], Rt = elements['warp-canvas'];
    const dprWas = globalThis.devicePixelRatio;
    const setBox = (px) => { for (const c of [L, Rt]) { c.clientWidth = c.clientHeight = px; } };

    setBox(512);
    globalThis.devicePixelRatio = 2;
    fireWin('resize');
    await sleep(300);
    check('the previews are no longer told to render pixelated',
        /\.preview \{[^}]*image-rendering: auto/.test(html) &&
        /canvas \{ image-rendering: pixelated/.test(html),
        'preview auto, diagnostics pixelated');
    check('backing store = displayed box x devicePixelRatio',
        L.width === 1024 && L.height === 1024 && Rt.width === 1024,
        L.width + 'x' + L.height + ' for 512 css @2x');

    // Progressive refinement: the drag frame is cheap, the frame you stop on is
    // sharp. Rendering every drag frame at 1024 is ~15x the fill work of 256.
    fire('stl-canvas', 'pointerdown', { clientX: 100, clientY: 100 });
    fireWin('pointermove', { clientX: 128, clientY: 112 });
    const during = L.width;
    const t0 = Date.now();
    fireWin('pointerup', {});
    const settleMs = Date.now() - t0;
    const after = L.width;
    check('a drag frame renders at a reduced scale', during <= 384 && during < after,
        during + ' px while dragging');
    check('and the frame it settles on is full resolution', after === 1024,
        after + ' px settled');
    console.log('       full-resolution settle (both panes, 1024px): ' + settleMs + ' ms');
    check('a full-resolution frame stays interactive', settleMs < 2000, settleMs + ' ms');
    await sleep(900);

    setBox(4000);
    fireWin('resize');
    await sleep(300);
    check('and capped: a 4K window cannot ask for 8000 px',
        L.width === 1200, L.width + ' px');

    // A phone in the single-column layout: a full-width pane at devicePixelRatio
    // 3. Honouring that literally is ~8x the fill of the same page on a desktop
    // and it lands in one synchronous block on a slower CPU. Two device pixels
    // per CSS pixel is the cap.
    setBox(380);
    globalThis.devicePixelRatio = 3;
    fireWin('resize');
    await sleep(300);
    check('a phone at 3x renders at 2x, not 3x', L.width === 760,
        L.width + ' px for 380 css @3x');

    // Back to something quick for the rest of the suite.
    setBox(240);
    globalThis.devicePixelRatio = dprWas;
    fireWin('resize');
    await sleep(300);
    check('shrinking the window shrinks the raster back',
        L.width === 240 && Rt.width === 240, L.width + ' px');
} catch (e) {
    fail++;
    console.log('  FAIL resolution threw: ' + e.message);
    console.log(e.stack.split('\n').slice(1, 4).join('\n'));
}

console.log('\nA finger drags the same as a mouse');
try {
    // The panes were mouse-only until FF/Android showed what that means: a
    // finger raises no mouse events at all, so the drag fell through to the
    // page and scrolled it. There was no rotation on any phone.
    const camPre = rot().CamM, objPre = rot().ObjM;
    touchDrag('warp-canvas', 40, 0);
    check('a one-finger drag on the right pane turns the camera',
        !same(rot().CamM, camPre) && same(rot().ObjM, objPre));
    const camMid = rot().CamM;
    touchDrag('stl-canvas', 0, 30);
    check('and on the left pane it tips the model, not the camera',
        !same(rot().ObjM, objPre) && same(rot().CamM, camMid));
    check('every drag on the pane is ours, not a scroll',
        /\.preview \{[^}]*touch-action: none/.test(html));

    // Two fingers are a pinch. Rotating off one of them spins the model while
    // it scales.
    const camPinch = rot().CamM, objPinch = rot().ObjM;
    const two = (ev, pid, x, y) =>
        fire('warp-canvas', ev, { pointerType: 'touch', pointerId: pid,
                                  isPrimary: pid === 11, clientX: x, clientY: y,
                                  preventDefault: () => {} });
    two('pointerdown', 11, 100, 100);
    two('pointerdown', 12, 140, 100);
    fireWin('pointermove', { pointerType: 'touch', pointerId: 12, isPrimary: false,
                             clientX: 260, clientY: 180, preventDefault: () => {} });
    check('a second finger hands over to the pinch',
        same(rot().CamM, camPinch) && same(rot().ObjM, objPinch));
    fireWin('pointerup', { pointerType: 'touch', pointerId: 11, clientX: 100, clientY: 100 });
    fireWin('pointerup', { pointerType: 'touch', pointerId: 12, clientX: 260, clientY: 180 });
    clickIt('reset-view');
    clickIt('reset-object');
    await sleep(900);
} catch (e) {
    fail++;
    console.log('  FAIL touch drag threw: ' + e.message);
    console.log(e.stack.split('\n').slice(1, 4).join('\n'));
}

console.log('\nThe view toggles are buttons on the canvas');
try {
    check('real buttons with a pressed state, not divs',
        /<button id="show-grid"[^>]*aria-pressed="true"/.test(html) &&
        /<button id="show-errors"[^>]*aria-pressed="false"/.test(html),
        'markup');
    check('and they sit inside the right canvas',
        html.indexOf('id="show-grid"') > html.indexOf('id="warp-canvas"') &&
        html.indexOf('id="show-grid"') < html.indexOf('id="detail"') &&
        !/<label class="check"/.test(html));
    // Each one names the verb and the thing, so nothing has to be inferred
    // from an icon or from which of two nouns is currently blue.
    check('they are labelled, not cryptic',
        />Show control grid</.test(html) && />Show deviation</.test(html));
    // Two options of one kind read as a row, not as a menu growing down the
    // picture. The strip is what is positioned; the buttons flow inside it.
    check('and they sit side by side, not stacked',
        /\.toggles \{[^}]*display: flex/.test(html) &&
        /<div class="toggles">[\s\S]*?id="show-grid"[\s\S]*?id="show-errors"[\s\S]*?<\/div>/.test(html) &&
        !/#show-errors \{ top:/.test(html));

    // Pressed state is what a screen reader reads and what the blue fill shows.
    setToggle('show-grid', true);
    check('pressed state and the selected class agree',
        pressed('show-grid') && /\bon\b/.test(elements['show-grid'].className),
        elements['show-grid'].className);
    clickIt('show-grid');
    check('clicking releases both', !pressed('show-grid') &&
        !/\bon\b/.test(elements['show-grid'].className),
        elements['show-grid'].className);
    clickIt('show-grid');
    check('and clicking again presses them', pressed('show-grid'));

    // On a drag surface, so a press must not also start an orbit.
    const camPre = rot().CamM, objPre = rot().ObjM;
    let stopped = false;
    fire('show-errors', 'pointerdown', { stopPropagation() { stopped = true; }, clientX: 20, clientY: 20 });
    fireWin('pointermove', { clientX: 90, clientY: 60 });
    fireWin('pointerup', {});
    check('pressing one never starts a rotation',
        stopped && same(rot().CamM, camPre) && same(rot().ObjM, objPre));
    await sleep(600);
} catch (e) {
    fail++;
    console.log('  FAIL view toggles threw: ' + e.message);
    console.log(e.stack.split('\n').slice(1, 4).join('\n'));
}

console.log('\nThe error colormap, on the surface it describes');
try {
    // It paints the FITTED SURFACE in the right pane, not the input mesh: that
    // is the object whose accuracy is in question.
    const plain = pixels('warp-canvas').slice();
    const greyPlain = countPixels((r, g, b) => r === g && g === b, 'warp-canvas');
    const scadBefore = elements['scad-out'].value;

    setToggle('show-errors', true);
    // A colour bar, not a sentence: the mapping is shown rather than described.
    check('a colour bar appears, and no prose with it',
        elements['cmap-bar'].className === '' &&
        elements['cmap-legend'].textContent === '',
        elements['cmap-legend'].textContent || 'no prose');
    check('it is marked +max / 0 / -max, in a metric unit',
        /^\+[\d.]+ (mm|\u00b5m)$/.test(elements['cmap-hi'].textContent) &&
        elements['cmap-mid'].textContent === '0' &&
        /^\u2212[\d.]+ (mm|\u00b5m)$/.test(elements['cmap-lo'].textContent),
        elements['cmap-hi'].textContent + ' / ' + elements['cmap-mid'].textContent +
        ' / ' + elements['cmap-lo'].textContent);
    // One definition of the error, one scale: the ends of the bar are the
    // 99th-percentile scale computeErrorField() coloured the surface by.
    check('and those ends are the colour scale',
        elements['cmap-hi'].textContent === '+' + fmtErr(rot().errorScale) &&
        elements['cmap-lo'].textContent === '\u2212' + fmtErr(rot().errorScale),
        elements['cmap-hi'].textContent + ' vs scale ' + rot().errorScale);
    // Painted from diverging() itself, so it cannot drift from the surface.
    {
        const bar = elements['cmap-canvas'];
        const d = bar.getContext().getImageData(0, 0, bar.width, bar.height).data;
        const at = (y) => { const i = 4 * (y * bar.width + 3); return [d[i], d[i+1], d[i+2]]; };
        const top = at(2), mid = at(bar.height >> 1), bot = at(bar.height - 3);
        check('warm at the top, neutral, cool at the bottom',
            top[0] > top[2] + 40 && bot[2] > bot[0] + 40 &&
            Math.abs(mid[0] - mid[2]) < 30 && mid[0] > 180,
            top.join(',') + ' / ' + mid.join(',') + ' / ' + bot.join(','));
    }
    check('turning it on does not touch the output',
        elements['scad-out'].value === scadBefore &&
        elements['status'].textContent === 'ready');

    const painted = pixels('warp-canvas');
    check('the surface really is repainted',
        differing(plain, painted) > 2000 &&
        countPixels((r, g, b) => r === g && g === b, 'warp-canvas') < greyPlain,
        differing(plain, painted) + ' px changed');
    // Multi-hue and diverging: both a warm and a cool family must be present,
    // not one colour fading out.
    check('both directions are on screen, in different hues',
        countPixels((r, g, b) => r > b + 30, 'warp-canvas') > 100 &&
        countPixels((r, g, b) => b > r + 30, 'warp-canvas') > 100,
        countPixels((r, g, b) => r > b + 30, 'warp-canvas') + ' warm / ' +
        countPixels((r, g, b) => b > r + 30, 'warp-canvas') + ' cool px');
    // It has to coexist with the control grid, which is on by default.
    check('the control grid is still legible over the palette',
        pressed('show-grid') &&
        (() => {
                    setToggle('show-grid', false);
            const off = pixels('warp-canvas').slice();
                    setToggle('show-grid', true);
            return differing(off, pixels('warp-canvas')) > 200;
        })(),
        'grid over colour');

    check('the left pane is left alone: one control, one place',
        !/show-errors/.test(html.slice(0, html.indexOf('<div class="pane">', 1))) ||
        html.indexOf('id="show-errors"') > html.indexOf('id="warp-canvas"'),
        'checkbox sits with the surface it paints');

    setToggle('show-errors', false);
    check('turning it off hides the bar and restores the shading',
        elements['cmap-bar'].className === 'hidden' &&
        elements['cmap-legend'].textContent === '' &&
        differing(plain, pixels('warp-canvas')) === 0);
} catch (e) {
    fail++;
    console.log('  FAIL colormap threw: ' + e.message);
    console.log(e.stack.split('\n').slice(1, 4).join('\n'));
}

console.log('\nThe cut-off line');
try {
    // Start from a known place: the cut-off under the model, keeping all of it.
    // Earlier sections leave the object at whatever angle they finished on, and
    // the slider is an absolute height, so its meaning depends on that angle.
    elements['stl-water'].value = sliderFor(rot().zRange[0]);
    fire('stl-water', 'input');
    await sleep(900);
    const beforeRelief = parseFloat(elements['size-height'].value);
    const [lo, hi] = rot().zRange;
    elements['stl-water'].value = sliderFor(lo + 0.45 * (hi - lo));
    fire('stl-water', 'input');
    // The slider sets a HEIGHT, so the height leads and the percentage is
    // derived from the model's current extent. A percentage alone does not say
    // how much model is left, and it is no longer what the slider controls.
    check('the readout leads with mm, percentage derived',
        /^Top \d+\.\d\d mm \u2014 5[456]% of the model$/
            .test(elements['water-info'].textContent) &&
        !/depth/i.test(elements['water-info'].textContent),
        elements['water-info'].textContent);
    check('and the output height drops',
        parseFloat(elements['size-height'].value) < beforeRelief,
        beforeRelief.toFixed(3) + ' -> ' + elements['size-height'].value);
    await sleep(700);
    check('and the pipeline re-runs itself', elements['status'].textContent === 'ready',
        elements['status'].textContent);
    // With half the model below the line, the discarded part must be visible
    // as such in the preview.
    check('the discarded geometry shows below the cut-off',
        countPixels((r, g, b) => b > r + 30 && b > 60) > 200,
        countPixels((r, g, b) => b > r + 30 && b > 60) + ' blue px');
} catch (e) { fail++; console.log('  FAIL view/cut-off threw: ' + e.message); }

console.log('\nThe cut-off slider is on the canvas, and self-evident');
try {
    // Markup: it stays a native range input, so it is keyboard operable and
    // accessible without anything being reimplemented by hand.
    const tag = /<input[^>]*id="stl-water"[^>]*>/.exec(html)[0];
    check('it is still a native range input with a label',
        /type="range"/.test(tag) && /aria-label="[^"]+"/.test(tag), tag.slice(0, 70));
    check('overlaid on the left canvas, not a labelled row',
        html.indexOf('id="stl-water"') > html.indexOf('id="stl-canvas"') &&
        html.indexOf('id="stl-water"') < html.indexOf('</div>', html.indexOf('id="stl-canvas"')) &&
        !/<span>Cut-off<\/span>/.test(html));
    check('the inline error moved onto the canvas with it',
        html.indexOf('id="err-water"') > html.indexOf('id="stl-canvas"') &&
        html.indexOf('id="err-water"') < html.indexOf('id="stl-info"'));
    // 'input' is what a keyboard arrow raises, so the pipeline hangs off it and
    // the keyboard keeps working whatever the pointer does.
    check('it is driven from input, which is what arrow keys fire',
        !!(handlers['stl-water'] || {}).input);
    // The pointer never reaches the input: a native range answers the click a
    // touch leaves behind by moving its own value.
    check('and a drag is tracked on the track, never by the native range',
        !!(handlers['water-track'] || {}).pointerdown &&
        !!(handlers['water-track'] || {}).pointermove &&
        !(handlers['stl-water'] || {}).pointerdown,
        /pointer-events:\s*none/.test(html) ? 'input takes no pointer' : 'input still takes pointers');

    const camPre = rot().CamM, objPre = rot().ObjM;
    const [wlo, whi] = rot().zRange;
    elements['stl-water'].value = sliderFor(wlo + 0.3 * (whi - wlo));
    fire('stl-water', 'input');
    const low = rot().waterLevel;
    check('using it moves neither the model nor the camera',
        same(rot().CamM, camPre) && same(rot().ObjM, objPre));
    // The visual axis is CSS (writing-mode + direction:rtl put the maximum at
    // the top); the value semantics are asserted here.
    elements['stl-water'].value = sliderFor(wlo + 0.6 * (whi - wlo));
    fire('stl-water', 'input');
    check('a higher value is a higher cut-off', rot().waterLevel > low,
        low.toFixed(3) + ' -> ' + rot().waterLevel.toFixed(3));

    // The figure is not permanent furniture, but it is one gesture away.
    check('the value reads out transiently, in mm, beside the thumb',
        /^Top \d+\.\d\d mm \u2014 \d+% of the model$/
            .test(elements['water-info'].textContent) &&
        elements['water-info'].className === 'show',
        elements['water-info'].textContent + ' [' + elements['water-info'].className + ']');
    fire('water-track', 'mouseenter');
    check('and hovering it is enough to see the figure',
        elements['water-info'].className === 'show');

    // The drag: the box is top 100, height 300, 7px of padding at each end, so
    // the travel runs from y=393 at the low end up to y=107 at the high one.
    fire('water-track', 'pointerdown', { pointerId: 1, clientY: 393 });
    check('grabbing at the bottom of the travel is the low end',
        elements['stl-water'].value === '0', elements['stl-water'].value);
    fire('water-track', 'pointermove', { pointerId: 1, clientY: 250 });
    check('and the value follows the pointer up',
        Math.abs(Number(elements['stl-water'].value) - 500) <= 5,
        elements['stl-water'].value);
    // The complaint this answers: the grip has to be seen to move with the
    // finger, not just the cut-off it sets.
    const gripAt = () => {
        const m = /\* ([\d.]+)\)/.exec(elements['water-grip'].style.bottom || '');
        return m ? Number(m[1]) : NaN;
    };
    check('and the grip is drawn where the finger is',
        Math.abs(gripAt() - 0.5) <= 0.01, elements['water-grip'].style.bottom);
    fire('water-track', 'pointermove', { pointerId: 1, clientY: 350 });
    check('and moves back down with it',
        Math.abs(gripAt() - 0.15) <= 0.02, elements['water-grip'].style.bottom);
    // Past the end of the strip, not off the control: the capture is the point.
    fire('water-track', 'pointermove', { pointerId: 1, clientY: 900 });
    check('a finger past the end of the strip stays on the slider',
        elements['stl-water'].value === '0', elements['stl-water'].value);
    fire('water-track', 'pointermove', { pointerId: 2, clientY: 250 });
    check('and a second pointer does not steer it',
        elements['stl-water'].value === '0', elements['stl-water'].value);
    fire('water-track', 'pointerup', { pointerId: 1, clientY: 900 });
    await sleep(900);
} catch (e) {
    fail++;
    console.log('  FAIL cut-off slider threw: ' + e.message);
    console.log(e.stack.split('\n').slice(1, 4).join('\n'));
}

console.log('\nErrors appear next to the control that caused them');
try {
    elements['stl-water'].value = '1000';
    fire('stl-water', 'input');
    check('drowning the model reports under the slider',
        /above the cut-off/i.test(elements['err-water'].textContent) &&
        elements['err-water'].className === 'err',
        elements['err-water'].textContent);
    check('and not in a black diagnostic box',
        !/almost nothing|cut-off/i.test(elements['report-fit'].textContent) &&
        elements['err-out'].textContent === '');

    elements['stl-water'].value = '0';
    fire('stl-water', 'input');
    await sleep(700);
    check('recovering clears the inline error',
        elements['err-water'].textContent === '' &&
        /hidden/.test(elements['err-water'].className) &&
        elements['status'].textContent === 'ready', elements['status'].textContent);
} catch (e) { fail++; console.log('  FAIL inline errors threw: ' + e.message); }

console.log('\nEdited export sizes survive an orbit');
try {
    elements['size-height'].value = '250';
    fire('size-height', 'change');
    check('editing output scale re-emits the code',
        /^size = \[[^\n]*, ?250\]/m.test(elements['scad-out'].value),
        (/^size = \[[^\n]*/m.exec(elements['scad-out'].value) || [''])[0]);

    check('and says the sizes are the user’s now',
        /your sizes/i.test(elements['size-src'].textContent), elements['size-src'].textContent);

    const warpBefore = elements['report-warp'].textContent;
    drag('warp-canvas', 40, 18);
    check('orbiting does not clobber the edited size',
        elements['size-height'].value === '250', elements['size-height'].value);
    check('editing output scale did not refit',
        elements['report-warp'].textContent === warpBefore);
    drag('stl-canvas', 25, 15);
    await sleep(900);
    check('nor does re-aiming the cut-off',
        elements['size-height'].value === '250' &&
        elements['status'].textContent === 'ready',
        elements['size-height'].value + ' / ' + elements['status'].textContent);
} catch (e) { fail++; console.log('  FAIL export size persistence threw: ' + e.message); }

console.log('\nDetail knob');
try {
    const lines = (id) => elements[id].value.split('\n').length;
    const patches = (id) => (elements[id].value.match(/^  \[\[\[/gm) || []).length;

    // The knob is dragged on its own track too: a native range is no more
    // catchable across 8 stops than it is up the side of a canvas.
    check('the detail knob is on a track of its own',
        !!(handlers['detail-track'] || {}).pointerdown &&
        !(handlers['detail'] || {}).pointerdown);
    // The stub box is 44 wide from x=0, 7px of pad at each end.
    fire('detail-track', 'pointerdown', { pointerId: 9, clientX: 7 });
    check('the left end of the track is the coarsest level',
        elements['detail'].value === '1', elements['detail'].value);
    fire('detail-track', 'pointermove', { pointerId: 9, clientX: 37 });
    check('and the right end the finest',
        elements['detail'].value === '8', elements['detail'].value);
    fire('detail-track', 'pointermove', { pointerId: 9, clientX: 22 });
    check('and it snaps to the stops in between',
        elements['detail'].value === '5', elements['detail'].value);
    check('with the grip drawn at the level it set',
        /\* 0\.5714/.test(elements['detail-grip'].style.left || ''),
        elements['detail-grip'].style.left);
    fire('detail-track', 'pointerup', { pointerId: 9, clientX: 22 });
    await sleep(600);

    elements['detail'].value = '1';
    fire('detail', 'input');
    check('the level shows before anything reruns',
        /^Level 1\/8/.test(elements['detail-info'].textContent),
        elements['detail-info'].textContent);
    await sleep(600);
    // There are no nx/ny/degree fields any more, so the only evidence the knob
    // reached the maths is the maths itself.
    check('and it reached both stages: 4x4 net, degree 3 patch',
        /control net 4 x 4/.test(elements['report-fit'].textContent) &&
        /degree {9}3 x 3/.test(elements['report-warp'].textContent),
        (/degree[^\n]*/.exec(elements['report-warp'].textContent) || [''])[0]);
    const lowFit = lines('scad-fit'), lowPatches = patches('scad-fit');
    const lowRms = LAST_RMS();

    elements['detail'].value = '7';
    fire('detail', 'input');
    await sleep(900);
    const hiFit = lines('scad-fit'), hiPatches = patches('scad-fit');
    const hiRms = LAST_RMS();

    check('more detail means more patches', hiPatches > lowPatches,
        lowPatches + ' -> ' + hiPatches);
    check('and a longer file', hiFit > lowFit, lowFit + ' -> ' + hiFit + ' lines');
    check('and a closer fit', hiRms < lowRms, lowRms.toFixed(3) + ' -> ' + hiRms.toFixed(3) + ' units');

    // The outline patch is always a single patch, whatever the detail level.
    check('the output stays one patch', patches('scad-out') === 1,
        lines('scad-out') + ' lines');

    // Which is exactly why the readout cannot quote lines: one patch on one
    // line is the same file length at every level. The figure that moves is
    // the control net, so that is the one the knob has to show.
    const net = () => (/(\d+)\u00d7(\d+) control points/
        .exec(elements['detail-info'].textContent) || [0, 0])[1];
    const hiNet = net();
    elements['detail'].value = '1';
    fire('detail', 'input');
    await sleep(900);
    check('the readout tracks the level', +net() < +hiNet && +net() > 0,
        hiNet + ' -> ' + net() + ' control points a side');

    // File length must be preamble + one line per patch.
    check('file length is preamble + one line per patch',
        hiFit - hiPatches === lowFit - lowPatches && hiFit - hiPatches < 40,
        (hiFit - hiPatches) + ' fixed lines');

    elements['detail'].value = '5';
    fire('detail', 'input');
    await sleep(700);
} catch (e) {
    fail++;
    console.log('  FAIL detail knob threw: ' + e.message);
}

console.log('\nStaleness and debounced auto-run');
try {
    elements['detail'].value = '6';
    fire('detail', 'input');
    check('a change reads as in-flight at once',
        /updating/.test(elements['status'].textContent),
        elements['status'].textContent);

    await sleep(900);
    check('the pipeline runs itself back to ready',
        elements['status'].textContent === 'ready', elements['status'].textContent);
    check('and the whole table entry took effect',
        /control net 12 x 12/.test(elements['report-fit'].textContent) &&
        /degree {9}10 x 10/.test(elements['report-warp'].textContent),
        (/degree[^\n]*/.exec(elements['report-warp'].textContent) || [''])[0]);
} catch (e) {
    fail++;
    console.log('  FAIL staleness threw: ' + e.message);
}

console.log('\nSilent fallback on an outline that cannot be followed');
try {
    elements['detail'].value = '5';
    fire('detail', 'input');
    elements['stl-upload'].files = [{ _buf: pinsStl(), name: 'pins.stl' }];
    fire('stl-upload', 'change');
    await sleep(50);

    check('there is still an output', /patches = \[/.test(elements['scad-out'].value),
        elements['scad-out'].value.split('\n').length + ' lines');
    check('it silently became the rectangular fit',
        elements['scad-out'].value === elements['scad-fit'].value,
        elements['scad-out'].value === elements['scad-warp'].value ? 'still the warp' : 'ok');
    check('with a one-line note, not a choice',
        elements['fallback-note'].className === '' &&
        elements['fallback-note'].textContent.length > 0 &&
        !/stage|warp/i.test(elements['fallback-note'].textContent),
        elements['fallback-note'].textContent);
    check('the diagnostics still record why',
        /warp failed/.test(elements['report-warp'].textContent) &&
        /fallback/.test(elements['sub-warp'].textContent),
        elements['sub-warp'].textContent);
    check('the user is not shown an error for it',
        elements['err-out'].textContent === '' &&
        elements['status'].textContent === 'ready', elements['status'].textContent);
    check('the download follows the new filename',
        (downloads.length = 0, clickIt('download-scad'), downloads[0].download === 'pins.scad'),
        downloads.length ? downloads[0].download : 'none');
} catch (e) {
    fail++;
    console.log('  FAIL fallback threw: ' + e.message);
    console.log(e.stack.split('\n').slice(1, 4).join('\n'));
}

console.log('\nSample model');
try {
    clickIt('sample-load');
    await sleep(700);

    check('the sample loads through the same path as an upload',
        elements['workspace'].className === '' &&
        /pebble/.test(elements['drop-text'].textContent),
        elements['drop-text'].textContent);
    check('and produces an output',
        /patches = \[/.test(elements['scad-out'].value) &&
        elements['status'].textContent === 'ready',
        elements['scad-out'].value.split('\n').length + ' lines, ' +
        elements['status'].textContent);
    // The point of the sample is to demonstrate the tool's actual use --
    // isolating a piece of a curved surface. It parks the cut-off itself, so
    // what the first-time user sees must be the outline patch fitted to a real
    // region of the stone, not the whole silhouette and not the fallback.
    check('it selects a piece, not all and not none',
        (() => {
            const w = +elements['stl-water'].value;
            return w > 0 && w < 1000;
        })(), 'cut-off slider at ' + elements['stl-water'].value + ' of 1000');
    check('and it does not land on the rectangular fallback',
        elements['fallback-note'].className === 'hidden',
        elements['fallback-note'].textContent || '(no note)');
    check('a second press gives a different model',
        (() => {
            const before = elements['scad-out'].value;
            clickIt('sample-load');
            return elements['scad-out'].value !== before;
        })());
    await sleep(700);

    // Randomised per press, but reproducible from a seed -- so a pebble that
    // ever does fit badly can be reported and looked at rather than described.
    const SAMPLE = require(path.join(root, 'src/sample.js'));
    const a1 = Buffer.from(SAMPLE.pebble(4242).buffer);
    const a2 = Buffer.from(SAMPLE.pebble(4242).buffer);
    const b1 = Buffer.from(SAMPLE.pebble(4243).buffer);
    check('the same seed gives the same stone', a1.equals(a2));
    check('a different seed gives a different one', !a1.equals(b1));
    check('and it is one closed surface, not a pile of parts',
        (() => {
            const STLm = require(path.join(root, 'src/stl.js'));
            const m = STLm.parseSTL(SAMPLE.pebble(4242).buffer);
            const ids = new Map();
            const idx = new Int32Array(m.count * 3);
            let n = 0;
            for (let t = 0; t < m.count * 3; t++) {
                const k = m.verts[t * 3] + ',' + m.verts[t * 3 + 1] + ',' + m.verts[t * 3 + 2];
                let id = ids.get(k);
                if (id === undefined) { id = n++; ids.set(k, id); }
                idx[t] = id;
            }
            const dir = new Map();
            for (let t = 0; t < m.count; t++) {
                const p3 = [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]];
                for (let j = 0; j < 3; j++) {
                    const k = p3[j] + ',' + p3[(j + 1) % 3];
                    dir.set(k, (dir.get(k) || 0) + 1);
                }
            }
            for (const [k, v] of dir) {
                const [x, y] = k.split(',');
                if (v > 1 || !dir.get(y + ',' + x)) return false;
            }
            return true;
        })());
} catch (e) {
    fail++;
    console.log('  FAIL sample threw: ' + e.message);
    console.log(e.stack.split('\n').slice(1, 4).join('\n'));
}

console.log('\nDeviation overlay: the edge of the colouring');
try {
    // The overlay's edge used to be cut at the tessellation grid, because a
    // triangle was painted or not as a whole, and its colour stepped in blocks
    // because the error was looked up at one rounded pixel. Measure it the way
    // it is seen: paint the surface with the overlay off and on, call the
    // pixels that changed "coloured", and look at that region.
    //
    // The control grid is turned off for this: it is drawn identically in both
    // passes, so every line it draws would read as an unpainted hole. And it
    // runs on the dome rather than on whichever sample the previous block
    // happened to generate -- the numbers below are a before/after comparison,
    // and a random outline makes them incomparable from one run to the next.
    elements['stl-upload'].files = [{ _buf: domeStl(), name: 'dome.stl' }];
    fire('stl-upload', 'change');
    await sleep(700);

    const gridWas = pressed('show-grid');
    setToggle('show-grid', false);
    setToggle('show-errors', false);
    const off = pixels('warp-canvas').slice();
    setToggle('show-errors', true);
    const on = pixels('warp-canvas').slice();

    const Wc = elements['warp-canvas'].width, Hc = elements['warp-canvas'].height;
    const isCol = new Uint8Array(Wc * Hc);
    let coloured = 0;
    for (let i = 0, p2 = 0; i < off.length; i += 4, p2++) {
        if (off[i] !== on[i] || off[i + 1] !== on[i + 1] || off[i + 2] !== on[i + 2]) {
            coloured++; isCol[p2] = 1;
        }
    }

    // Holes: unpainted pixels strictly inside the coloured region's own span
    // on a row. A triangle-at-a-time decision leaves these all along the mask
    // edge and wherever the patch reaches a pixel the raster did not cover.
    let holes = 0, span = 0;
    const edges = [];
    for (let y = 0; y < Hc; y++) {
        let lo = -1, hi = -1;
        for (let x = 0; x < Wc; x++) if (isCol[y * Wc + x]) { if (lo < 0) lo = x; hi = x; }
        edges.push([lo, hi]);
        if (lo < 0) continue;
        for (let x = lo; x <= hi; x++) { span++; if (!isCol[y * Wc + x]) holes++; }
    }

    // Staircase, measured as the CURVATURE of the coloured region's edge, not
    // its slope. A slope is the shape of the surface -- a long thin patch
    // legitimately gains many pixels a row near its ends -- but a staircase
    // holds still for a run of rows and then jumps, which shows up as a large
    // second difference and a smooth boundary of any steepness does not.
    let jumps = 0, worst = 0, n = 0, sum = 0;
    for (let y = 1; y + 1 < Hc; y++) {
        const a = edges[y - 1], b = edges[y], c2 = edges[y + 1];
        if (a[0] < 0 || b[0] < 0 || c2[0] < 0) continue;
        for (const k of [0, 1]) {
            const d = Math.abs(a[k] - 2 * b[k] + c2[k]);
            sum += d; n++;
            if (d > worst) worst = d;
            if (d > 3) jumps++;
        }
    }
    console.log('       coloured ' + coloured + ' px, holes ' + holes + ' of ' + span +
        ' inside the span (' + (100 * holes / Math.max(1, span)).toFixed(1) + '%)' +
        ', edge kink mean ' + (n ? sum / n : 0).toFixed(2) +
        ' px worst ' + worst + ', over 3 px: ' + jumps + ' of ' + n);

    // Measured on this dome, before and after: unpainted fringe 232 px (1.2%
    // of the span) -> 48 px (0.2%); edge kink mean 1.38 -> 0.92 px, worst
    // 19 -> 8 px, rows kinking by over 3 px 45 of 308 (15%) -> 10 of 310 (3%).
    // Both thresholds below fail on the previous code.
    check('the overlay fills the surface, without holes',
        holes < 0.005 * span,
        (100 * holes / Math.max(1, span)).toFixed(1) + '% of the span unpainted');
    check('and its edge follows the surface, not the tessellation',
        jumps <= 0.08 * n,
        (100 * jumps / Math.max(1, n)).toFixed(0) + '% of rows kink by over 3 px' +
        ', worst ' + worst);
    setToggle('show-grid', gridWas);
} catch (e) {
    fail++;
    console.log('  FAIL overlay edge threw: ' + e.message);
    console.log(e.stack.split('\n').slice(1, 4).join('\n'));
}

console.log('\nThe pipeline is sliced across frames too');
const REAL_PERF_PIPE = globalThis.performance;
try {
    // A run is the longest thing the page does; held in one piece it is what a
    // phone stops the script for.
    const frames = [];
    globalThis.requestAnimationFrame = (fn) => frames.push(fn);
    const settled = elements['scad-out'].value;

    // Turn the object, which restarts the pipeline from the input stage.
    fire('stl-canvas', 'pointerdown',
         { pointerId: 5, pointerType: 'mouse', clientX: 10, clientY: 10 });
    fireWin('pointermove', { pointerId: 5, clientX: 70, clientY: 40 });
    fireWin('pointerup', { pointerId: 5 });
    await sleep(400);           // past the debounce, so the run is under way

    let slices = 0;
    while (frames.length && slices < 4000) { slices++; frames.shift()(); }
    check('a run takes more than one frame, and finishes', slices > 1,
        slices + ' frames');
    check('and it produces output, not a half-finished state',
        elements['scad-out'].value && elements['scad-out'].value !== settled,
        elements['scad-out'].value.split('\n').length + ' lines');

    // Same computation either way: the yields carry state, they do not change it.
    delete globalThis.requestAnimationFrame;
    const sliced = elements['scad-out'].value;
    fire('detail', 'input');
    await sleep(700);
    fire('detail', 'input');
    await sleep(700);
    check('a run driven straight through gives the same answer as a sliced one',
        elements['scad-out'].value === sliced,
        elements['scad-out'].value === sliced ? 'identical' : 'differs');
} catch (e) {
    fail++;
    console.log('  FAIL sliced pipeline threw: ' + e.message);
    console.log(e.stack.split('\n').slice(1, 4).join('\n'));
} finally {
    globalThis.performance = REAL_PERF_PIPE;
    delete globalThis.requestAnimationFrame;
}

console.log('\nRedraws are sliced across frames');
const REAL_PERFORMANCE = globalThis.performance;
try {
    // With frames to wait for, a drag must not draw on the spot: the work is
    // what a browser stops the script for.
    const frames = [];
    globalThis.requestAnimationFrame = (fn) => frames.push(fn);
    const ctx = elements['stl-canvas'].getContext();
    const before = ctx.blits;

    fire('stl-canvas', 'pointerdown',
         { pointerId: 3, pointerType: 'mouse', clientX: 10, clientY: 10 });
    fireWin('pointermove', { pointerId: 3, clientX: 24, clientY: 18 });
    check('a drag asks for a frame instead of drawing in the handler',
        ctx.blits === before && frames.length === 1,
        ctx.blits - before + ' blits, ' + frames.length + ' frames');

    fireWin('pointermove', { pointerId: 3, clientX: 31, clientY: 25 });
    check('and a second move joins that frame rather than queueing another',
        frames.length === 1, frames.length + ' frames');

    const drain = () => {
        let ran = 0;
        while (frames.length && ctx.blits === before && ran < 500) { ran++; frames.shift()(); }
        return ran;
    };
    check('running the frames is what reaches the canvas', drain() && ctx.blits > before,
        ctx.blits - before + ' blits');

    // A mesh this size fits in one slice on most machines, which leaves the
    // interesting path -- a draw spread over several frames -- untested, and
    // on a machine slow enough it would fail an assertion written for one
    // slice. A clock that jumps past the deadline on every reading is what
    // being too slow to finish a slice looks like, without needing to be.
    let tick = 0;
    globalThis.performance = { now: () => (tick += 5) };
    const slowFrom = ctx.blits;
    fireWin('pointermove', { pointerId: 3, clientX: 44, clientY: 33 });
    let slices = 0;
    while (frames.length && ctx.blits === slowFrom && slices < 500) { slices++; frames.shift()(); }
    check('a draw too big for one slice spans frames, and still finishes',
        slices > 1 && ctx.blits > slowFrom, slices + ' frames');

    fireWin('pointerup', { pointerId: 3 });
} catch (e) {
    fail++;
    console.log('  FAIL sliced redraw threw: ' + e.message);
    console.log(e.stack.split('\n').slice(1, 4).join('\n'));
} finally {
    // Unconditionally: a stub left installed by a throw here would break every
    // test after it, and the failure would be reported against the wrong one.
    globalThis.performance = REAL_PERFORMANCE;
    delete globalThis.requestAnimationFrame;
}
await sleep(700);

console.log('\nDefault view: no prose, and none of it computed');
{
    // Re-run the bundle the way a user gets it. The reports must stay empty --
    // not merely hidden -- and the one output the product shows must still be
    // there, which is the whole point of gating: nothing that matters to a
    // user depends on the diagnostics being built.
    for (const id of ['report-fit', 'report-warp', 'sub-fit', 'sub-warp'])
        elements[id].textContent = '';
    for (const id of ['scad-fit', 'scad-warp', 'scad-out']) elements[id].value = '';
    elements['diagnostics'].className = '';

    // Drop the first instance's listeners, or both instances answer the
    // upload and the debug-enabled one writes the reports anyway.
    for (const k of Object.keys(handlers)) delete handlers[k];
    for (const k of Object.keys(winHandlers)) delete winHandlers[k];

    globalThis.location = { search: '' };
    const bundle = require.resolve(path.join(root, 'public/script.js'));
    delete require.cache[bundle];
    require(bundle);

    elements['stl-upload'].files = [{ _buf: domeStl(), name: 'dome.stl' }];
    fire('stl-upload', 'change');
    await sleep(700);

    check('the product still produces its output',
        /patches = \[/.test(elements['scad-out'].value),
        elements['scad-out'].value.split('\n').length + ' lines');
    check('no prose report was written',
        ['report-fit', 'report-warp', 'sub-fit', 'sub-warp']
            .every((id) => elements[id].textContent === ''),
        ['report-fit', 'report-warp', 'sub-fit', 'sub-warp']
            .filter((id) => elements[id].textContent !== '').join(', ') || 'all empty');
    check('and the second stage was not emitted for nobody to read',
        elements['scad-fit'].value === '' || elements['scad-warp'].value === '');
    check('the disclosure is not put into debug mode',
        elements['diagnostics'].className !== 'debug',
        elements['diagnostics'].className || '(none)');
}

console.log('\nStale-bundle detection');
{
    // If index.html and script.js drift apart, the page must say so rather
    // than render fine with every control dead.
    const boot = [];
    globalThis.__beziverBootError = (msg) => boot.push(msg);
    const realGet = globalThis.document.getElementById;
    const realCreate = globalThis.document.createElement;
    globalThis.document = {
        getElementById: (id) => (id === 'stl-upload' ? null : realGet(id)),
        createElement: realCreate,
    };

    const bundle = require.resolve(path.join(root, 'public/script.js'));
    delete require.cache[bundle];
    let threw = false;
    try { require(bundle); } catch (e) { threw = true; }

    check('a missing element aborts the load', threw);
    check('and the failure names the element and the cause',
        boot.some((m) => m.includes('stl-upload') && /out of sync/.test(m)),
        boot[0] || 'no boot error reported');

    globalThis.document = { getElementById: realGet, createElement: realCreate };
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
}

main();
