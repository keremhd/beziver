const FIT = require('./fit.js');
const CONTOUR = require('./contour.js');
const REPORT = require('./report.js');
const WARP = require('./warp.js');
const STL = require('./stl.js');
const SAMPLE = require('./sample.js');

// Bumped whenever index.html and this file must ship together; the page
// checks it so a stale bundle announces itself instead of silently doing
// nothing. Keep in sync with window.BEZIVER_BUILD in index.html.
const BUILD = 20;

// The text analyses under Diagnostics were written for the rewrite, not for a
// person using the tool: they caught the folds, the oscillating control net
// and the boundary error, and the durable version of that value now lives in
// the test suite. They have no audience on the page, so they are off unless
// ?debug=1 is in the URL -- and when they are off the strings are not built at
// all, since nothing would read them.
//
// The diagnostic IMAGES are not gated. They are pictures of the input and of
// what came out of it, and they explain themselves.
const DEBUG = /[?&]debug=1\b/.test(
    (typeof location !== 'undefined' && location.search) || '');

(() => {
try {

// getElementById returns null for a missing id, and the TypeError that
// surfaces three lines later names neither the id nor the cause.
const el = (id) => {
    const e = document.getElementById(id);
    if (!e) throw new Error('missing element #' + id +
        ' \u2014 this page and its script are out of sync');
    return e;
};
const ctx2d = (id, opts) => el(id).getContext('2d', opts);

const InputCtx = ctx2d('input-canvas', { willReadFrequently: true });
const MaskCtx = ctx2d('mask-canvas');
const ResultCtx = ctx2d('result-canvas');
const WarpCtx = ctx2d('warp-canvas');
const DomainCtx = ctx2d('domain-canvas');
const StlCtx = ctx2d('stl-canvas');
const BarCtx = ctx2d('cmap-canvas');

let Input = null;      // { W, H, z, mask, contour, unitScale, ... }
let LastFit = null;
let LastWarp = null;
let Mesh = null;       // parsed STL
let Depth = null;      // last orthographic depth render
let FileName = 'model.stl';
// The cut-off the model arrived with. Reset model puts it back, because the
// two are one gesture's worth of state: the capture axis is derived from the
// object, so a rotation and the height you aimed at are the same act of
// framing, and undoing half of it leaves a state the user never chose.
let LoadWater = '0';

// THREE rotations, each with exactly one owner. Keeping them separate is the
// whole design; an earlier version had two and coupled them, and the coupling
// is what made the water appear to move.
//
//   ObjM    the model's orientation in the world. The LEFT drag turns this and
//           nothing else. Tipping the object is the input gesture.
//   WaterM  the cut-off plane's orientation in the world. Level, and it never
//           turns -- the slider sets its HEIGHT, not its angle. It is identity
//           and stays identity; it is named and used explicitly because the
//           capture axis is derived from it, and a derivation that reads
//           "water, expressed in the object's frame" says what it means.
//   CamM    the camera. The RIGHT drag turns this and nothing else. Shared by
//           both panes.
//
// The capture axis is DERIVED, never dragged: capture space is the water frame
// seen from the object, CapM = WaterM * ObjM. Its third row is the water normal
// in object coordinates, which is exactly the orthographic axis depthRender
// projects along. Tip the object and the axis follows; move the camera and
// nothing at all happens to the pipeline.
//
// A previous round held the camera fixed RELATIVE TO THE CAPTURE FRAME during a
// left drag so the plane would not move on screen. That keeps the plane
// screen-static at the cost of physically swinging the camera through the
// world, and the eye tracks the world: it reads as the water sloshing. Real
// standing water is world-static, not screen-static. Nothing counter-rotates
// now; the water simply never moves.
//
// All three are 3x3 rotation matrices, not yaw/pitch/roll triples. The drags
// compose rotations (see installOrbit), and Euler angles do not compose by
// adding and subtracting components: doing it that way cancels cleanly for a
// horizontal drag and visibly does not for a diagonal one. Matrices have no
// such seam and no gimbal lock, and nothing downstream ever wanted the angles
// anyway -- depthRender takes transformed vertices.
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
let ObjM = IDENTITY.slice();       // model -> world
let WaterM = IDENTITY.slice();     // world -> water (level; the slider is height)
let CamM = IDENTITY.slice();       // world -> camera
let CapM = IDENTITY.slice();       // model -> capture, = WaterM * ObjM

// Everything that draws the model works in model coordinates, so the camera it
// is handed is the object's orientation followed by the camera's.
function deriveCapture() { CapM = mul3(WaterM, ObjM); }
const viewM = () => mul3(CamM, ObjM);

function mul3(A, B) {
    const C = new Array(9).fill(0);
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
        }
    }
    return C;
}
const tr3 = (A) => [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]];
const rotX = (a) => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
const rotY = (a) => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];

// Signed fit error on the capture-space pixel grid, cached from the last fit
// so the preview overlay does not recompute (and re-sort) it every drag frame.
let ErrField = null;   // { err: Float64Array, scale: number }

// Resolution of the previews. Deliberately not autoResolution(): that number
// sizes the pipeline's raster, this one is redrawn on every mouse-move.
//
// It used to be a flat 256 px stretched to whatever CSS box the canvas got,
// which is an upscale on any window and a 4x-per-axis upscale on a HiDPI
// screen -- the previews looked permanently soft, and `image-rendering:
// pixelated` was quietly making the best of it. The backing store now matches
// the displayed size times devicePixelRatio.
//
// But this rasteriser runs per drag frame and its cost is per fragment, so
// simply raising the constant makes dragging crawl: 256 -> 1000 px is 15x the
// fill work. Progressive refinement instead -- reduced scale while a drag is in
// flight, full resolution the moment it settles. Nobody is studying pixel
// detail while they rotate something.
const PREVIEW_MIN = 192;
const PREVIEW_MAX = 1200;      // a maximised 4K window must not ask for 4000px
const PREVIEW_DRAG = 384;      // ... and a drag frame must not ask for 1024
// A phone reports devicePixelRatio 3 or more. Honouring it edge to edge in the
// single-column layout asks for a ~1100px raster per pane -- 8x the fill work
// of the same page in a desktop-width column, on a CPU several times slower,
// in one synchronous block that a mobile browser is entitled to kill for
// running too long. Two device pixels per CSS pixel is past the point where
// more of them are visible on a screen held at arm's length.
const DPR_MAX = 2;

let Dragging = false;

function previewSize(id) {
    const c = el(id);
    const dpr = Math.min(DPR_MAX,
        (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    // clientWidth is 0 before layout and undefined outside a browser.
    const css = c.clientWidth || c.clientHeight || 256;
    const n = Math.max(PREVIEW_MIN, Math.min(PREVIEW_MAX, Math.round(css * dpr)));
    return Dragging ? Math.min(n, PREVIEW_DRAG) : n;
}

// True once the user has typed in one of the export-size fields. After that the
// app stops refilling them from the mesh on every orbit -- otherwise a nudge of
// the preview silently throws away what they typed.
let sizeTouched = false;

// The warp is the one output. If it fails on a pathological outline we fall
// back to the rectangular fit silently and say so in one line.
let usingFallback = false;

// Errors are reported in the input's own units: the above-water relief of the
// STL, in model units.
const uScale = () => (Input && Input.unitScale) || 1;
const uName = () => (Input && Input.unitName) || 'mm';
// Every error magnitude the page prints goes through report.js's formatter, so
// the reports, the pane readouts and the colour bar cannot disagree about the
// same number. It carries its own unit, including the step down to micrometres.
const fe = (v) => REPORT.fmtErr(v, uName());

setSize(InputCtx, 100, 100);

function setSize(c, w, h) { c.canvas.width = w; c.canvas.height = h; }
function num(id, dflt) {
    const v = parseFloat(el(id).value);
    return Number.isFinite(v) ? v : dflt;
}

// ================================================== settled, not knobs
// These were all controls once. None of them is a decision the person making a
// printable surface can meaningfully make, so the app makes it. They are still
// passed through the same option objects fit.js / warp.js already accept --
// nothing downstream changed, the choice just stopped being a question.

// Cubic B-spline, always. The alternative (single-patch Bernstein) is worse at
// every detail level above 1 and the only way to want it is to already know
// what C2 continuity is.
const FIT_BASIS = 'bspline';

// Contour pixels get weighted up so the fit does not drift at the outline,
// which is exactly where stage 2 hands it to the boundary curves. The report
// used to tell the user to raise this when boundary rms ran past 2x interior;
// if the app knows the rule, the app applies it. 3 px band, 3x weight.
const EDGE_BAND = 3;
const EDGE_WEIGHT = 3;

// Second-difference regulariser on the stage-1 control net. This was a
// "Smoothing lambda" field, and nobody can pick it by eye: it is not a
// preference, it is the number that keeps control points outside the mask from
// running away. Measured on the dome at nx 10: lambda 0 leaves the outside-mask
// extrapolation at z -114 .. +234, while 1e-4 holds it to -1.8 .. 1.0 for a
// difference in rms of 0.0001 model units. There is no tradeoff to expose.
const FIT_LAMBDA = 1e-4;

// Harmonic domain map, always: it is measurably the one that folds less.
const WARP_DOMAIN = 'harmonic';
// Search for the four corners along the outline rather than spacing them
// equally -- equal spacing puts corners mid-feature on anything non-round.
const WARP_SEARCH_CORNERS = true;
// Hoschek parameter-correction passes on the boundary curves. 3 is where the
// boundary xy error stops improving.
const WARP_HOSCHEK = 3;
// Regularises the interior-height solve (see also the same idea in stage 1).
// Measured on the dome: without it the high-degree Bernstein net oscillates to
// max |z| 18.66 on a surface that lives in 0..1 -- invisible in the rendered
// surface, useless the moment you show the control net in OpenSCAD. 1e-6 drops
// that to 1.46 and slightly *improves* accuracy, so there is no tradeoff to
// expose.
const WARP_LAMBDA = 1e-6;

// Resolution of the depth raster the height field is sampled from. This was a
// "Resolution" number field; it is not a preference, it is "enough pixels to
// resolve the mesh and trace a smooth outline, few enough that the closed-form
// fit stays instant". A mesh of T triangles carries on the order of sqrt(T)
// features across an axis, so allow ~4 px per feature, snap to a multiple of 8
// and clamp hard: under 128 px the traced outline goes blocky and the contour
// lift gets noisy; over 256 px the solve stops feeling immediate while the fit
// error barely moves (the control net, not the sampling, is the limit).
function autoResolution(triangles) {
    const n = 4 * Math.sqrt(Math.max(1, triangles));
    return Math.max(128, Math.min(256, 8 * Math.round(n / 8)));
}

// ============================================================= the pipeline
// input -> fit -> warp. Everything downstream of a change is marked stale and
// re-run, so no stage can silently show results from an older input.

const STAGES = ['input', 'fit', 'warp'];
const state = { input: 'empty', fit: 'empty', warp: 'empty' };
let runTimer = null;
let running = false;
let errored = false;

function markStale(from) {
    const i = STAGES.indexOf(from);
    for (let k = i; k < STAGES.length; k++) {
        if (state[STAGES[k]] !== 'empty') state[STAGES[k]] = 'stale';
    }
    setStatus();
}

// The pipeline always runs itself; the debounce is so dragging a slider
// re-runs once at the end rather than per tick.
function scheduleRun(from) {
    markStale(from);
    if (runTimer) clearTimeout(runTimer);
    runTimer = setTimeout(() => { runTimer = null; runFrom(from); }, 280);
}

function runFrom(from) {
    if (running) return;
    running = true;
    errored = false;
    clearErrors();
    try {
        const i = STAGES.indexOf(from);
        if (i <= 0) ensureInput();
        if (i <= 1) runFit();
        if (i <= 2 && LastFit) {
            // The warp is the product. When it cannot be built the rectangular
            // fit is still a usable answer, so take it automatically -- this is
            // a fallback, never a question put to the user.
            try {
                runWarp();
                setFallback(false);
            } catch (e) {
                console.warn('warp failed, falling back', e);
                LastWarp = null;
                ErrField = null;
                state.warp = 'ok';
                setFallback(true);
                emitScad();
                // The right-hand preview is the product; it must show what the
                // code actually says, so repaint it from the rectangular fit
                // rather than leave the previous run's picture up.
                setResult({ kind: 'grid', grid: LastFit.grid,
                            cells: Math.round(Math.sqrt(LastFit.patches.length)) });
                if (DEBUG) el('report-warp').textContent = 'warp failed: ' + e.message +
                    '\nfell back to the rectangular fit';
            }
        }
    } catch (e) {
        fail(e);
    } finally {
        running = false;
        setStatus();
    }
}

// The prose blocks are hidden by CSS; ?debug=1 turns them back on.
function applyDebug() {
    if (DEBUG) el('diagnostics').className = 'debug';
}

function setFallback(on) {
    usingFallback = on;
    const n = el('fallback-note');
    if (on) {
        n.textContent = 'The outline could not be followed, so the surface ' +
            'covers a rectangle around the model instead.';
        n.className = '';
    } else {
        n.textContent = '';
        n.className = 'hidden';
    }
}

function runAll() {
    if (runTimer) { clearTimeout(runTimer); runTimer = null; }
    runFrom('input');
}

// One honest line: is what you are looking at the answer, or is it on its way?
function setStatus() {
    const busy = STAGES.some((k) => state[k] === 'stale');
    el('status').textContent =
        errored ? 'error'
        : state.input === 'empty' ? 'no STL loaded'
        : busy || running ? 'updating\u2026'
        : 'ready';
    if (DEBUG) el('sub-fit').textContent = state.fit === 'ok'
        ? `${LastFit.fit.Nx}x${LastFit.fit.Ny} net, rms ${fe(LastFit.st.rms)}`
        : '';
    if (DEBUG) el('sub-warp').textContent =
        state.warp !== 'ok' ? ''
        : LastWarp ? `degree ${LastWarp.w.degree}, rms ${fe(LastWarp.e2e)}`
        : 'failed - fell back to the rectangular fit';
}

// Errors belong next to the control that caused them. `e.where` names the
// control; anything unattributed lands under the output, never inside a
// collapsed black diagnostic box.
function fail(e) {
    errored = true;
    showError(e.where === 'water' ? el('err-water') : el('err-out'), e.message);
    console.error(e);
}

function showError(node, msg) { node.textContent = msg; node.className = 'err'; }
function clearError(node) { node.textContent = ''; node.className = 'err hidden'; }
function clearErrors() { clearError(el('err-water')); clearError(el('err-out')); }

function where(tag, e) { e.where = tag; return e; }

// ==================================================================== input

function ensureInput() {
    if (!Mesh) throw new Error('load an STL first');
    captureDepth();            // also commits the depth map as the height field
    state.input = 'ok';
    refreshExportSizes();
}

el('stl-upload').addEventListener('change', onStlUpload);
el('sample-load').addEventListener('click', loadSample);
installDropZone();

// Output scale only affects the emitted code, so re-emit without refitting.
// Typing in one of these fields also claims them: the app stops overwriting
// them from the mesh.
for (const id of ['size-x', 'size-y', 'size-height']) {
    el(id).addEventListener('change', () => {
        sizeTouched = true;
        refreshExportSizes();   // flips the label to "your sizes" straight away
        emitScad();
    });
    el(id).addEventListener('input', () => { sizeTouched = true; });
}

function drawMask() {
    const { W, H, mask, contour } = Input;
    setSize(MaskCtx, W, H);
    const img = MaskCtx.createImageData(W, H);
    const d = img.data;
    for (let i = 0; i < W * H; i++) {
        const v = mask[i] ? 205 : 32;
        d[4 * i] = d[4 * i + 1] = d[4 * i + 2] = v;
        d[4 * i + 3] = 255;
    }
    // Colour the outline along its traversal order: a correct trace runs
    // smoothly through the ramp, a broken ordering shows as speckle.
    for (let i = 0; i < contour.length; i++) {
        const t = i / Math.max(1, contour.length - 1);
        const [x, y] = contour[i];
        const o = 4 * (y * W + x);
        d[o] = Math.round(255 * (1 - t));
        d[o + 1] = Math.round(90 + 100 * t);
        d[o + 2] = Math.round(255 * t);
        d[o + 3] = 255;
    }
    MaskCtx.putImageData(img, 0, 0);
}

// ====================================================================== STL

function onStlUpload() {
    const files = el('stl-upload').files;
    if (files && files.length) loadFile(files[0]);
}

// The drop zone is the whole of the first screen, so it has to actually
// accept a drop, not merely look like it does.
function installDropZone() {
    const z = el('drop-zone');
    if (!z.addEventListener) return;
    const stop = (e) => { if (e && e.preventDefault) e.preventDefault(); };
    // The whole panel is the target, not just the file input inside it.
    z.addEventListener('click', (e) => {
        const input = el('stl-upload');
        // Both children handle their own click; the rest of the panel is the
        // picker's target. Without this the sample button would also open the
        // file dialog behind itself.
        if (e && (e.target === input || e.target === el('sample-load'))) return;
        if (input.click) input.click();
    });
    // Without this, a near-miss drop makes the browser navigate away to the
    // STL file and the user loses the page.
    if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('dragover', stop);
        window.addEventListener('drop', stop);
    }
    z.addEventListener('dragover', (e) => { stop(e); z.className = 'over'; });
    z.addEventListener('dragleave', () => { z.className = Mesh ? 'compact' : ''; });
    z.addEventListener('drop', (e) => {
        stop(e);
        z.className = Mesh ? 'compact' : '';
        const dt = e && e.dataTransfer;
        const f = dt && dt.files && dt.files[0];
        if (f) loadFile(f);
    });
}

// One entry point for every mesh, whoever produced it. `cut` is where to park
// the cut-off, as a fraction of the model's extent along the capture axis;
// undefined means the model's underside, so an uploaded file keeps all of
// itself and needs no decision. The sample passes a value because it knows
// which part of itself is worth looking at -- that is the only thing about it
// that differs from an upload, and it stops here.
function loadMesh(buffer, name, cut) {
    Mesh = STL.parseSTL(buffer);
    Mesh.bounds = STL.bounds(Mesh.verts);
    FileName = name || 'model.stl';
    // A fresh mesh starts level, with the camera looking straight down the
    // capture axis, so a user who drops a file and touches nothing still gets
    // output with zero clicks.
    ObjM = IDENTITY.slice();
    WaterM = IDENTITY.slice();
    CamM = IDENTITY.slice();
    deriveCapture();
    ErrField = null;
    CapExtent = null;
    sizeTouched = false;
    // Park the plane on the model's underside: the whole model is kept, and
    // the water is touching it rather than floating a radius below.
    const ext = captureExtent();
    const level = cut === undefined ? ext.lo[2]
        : ext.lo[2] + cut * (ext.hi[2] - ext.lo[2]);
    el('stl-water').value = String(waterSlider(level));
    LoadWater = el('stl-water').value;
    revealWorkspace();
    runAll();
}

function loadFile(file) {
    const reader = new FileReader();
    reader.onload = (ev) => {
        try { loadMesh(ev.target.result, (file && file.name) || 'model.stl'); }
        catch (e) { fail(e); }
    };
    reader.readAsArrayBuffer(file);
}

// A generated pebble, not a shipped asset: no page weight, and every press
// gives a different one. It arrives as a real binary STL through loadMesh, so
// it exercises the same parser and the same pipeline an upload does.
function loadSample() {
    try {
        const s = SAMPLE.pebble();
        loadMesh(s.buffer, s.name, s.cut);
    } catch (e) { fail(e); }
}

// Before an upload the page is one drop zone and nothing else; afterwards the
// zone shrinks to a filename bar and the two working panes appear.
function revealWorkspace() {
    el('workspace').className = '';
    el('drop-zone').className = 'compact';
    el('drop-text').textContent = FileName;
    el('drop-sub').textContent = 'drop another STL, or';
}

// One reset per rotation, and each one sits inside the canvas whose drag it
// undoes: the control lives where the gesture lives. A single "Reset" in a row
// underneath both panes could not say which of the two it meant.
//
// Reset model -- the object goes back to the orientation AND the cut-off it
// was loaded with. Both are pipeline inputs, both are framing, and the button
// is the way back to the state the file arrived in; putting the orientation
// back while leaving the cut-off where a since-undone rotation had it aimed
// gives a combination the user never picked.
installReset('reset-object', () => {
    ObjM = IDENTITY.slice();
    el('stl-water').value = LoadWater;
    updateWaterInfo();
    deriveCapture();
    try { drawPreview(); drawResult(); } catch (e) { return fail(e); }
    scheduleRun('input');
});

// Reset view -- the camera goes back to looking straight down. Never touches
// the object or the water, so it never recomputes: it is the way back to a
// known vantage point after free orbiting, not a way to undo a cut-off that
// took time to aim.
installReset('reset-view', () => {
    CamM = IDENTITY.slice();
    // Reset view means "get me back to a known vantage". A reset that leaves
    // you at 8x is not that, and zoom is part of the camera.
    Zoom = 1;
    afterCameraMove();
});

// Everything overlaid on a canvas sits ON a drag surface. Without this, using
// one of them would also grab the canvas underneath and start a rotation --
// the reset undone by a stray drag, or the model tipping while the cut-off is
// dragged.
function blockDrag(node) {
    for (const ev of ['pointerdown', 'pointermove', 'pointerup']) {
        node.addEventListener(ev, (e) => { if (e && e.stopPropagation) e.stopPropagation(); });
    }
}

// A control that turns something on the picture on or off belongs ON the
// picture, next to the reset that shares its canvas. These are real <button>s
// with aria-pressed rather than a div that answers to click: keyboard operable
// and correctly announced, for free.
function installToggle(id, on, fn) {
    const b = el(id);
    const paint = () => {
        b.className = 'toggle' + (on ? ' on' : '');
        if (b.setAttribute) b.setAttribute('aria-pressed', on ? 'true' : 'false');
    };
    b.addEventListener('click', (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        on = !on;
        paint();
        fn();
    });
    blockDrag(b);
    paint();
    return () => on;
}

function installReset(id, fn) {
    const b = el(id);
    b.addEventListener('click', (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        fn();
    });
    blockDrag(b);
}

// One camera, both panes. Moving it re-frames the left view and the right view
// together, which is what makes them read as one scene rather than two
// unrelated pictures.
function afterCameraMove() {
    if (!Mesh) return;
    try { drawPreview(); drawResult(); } catch (e) { fail(e); }
}

blockDrag(el('stl-water'));
// Reading the value is on demand, not permanent: the figure appears beside the
// thumb while the slider is in use and fades when it is not. A slider with no
// way to read its value would be a regression, and a line of text that is
// always there is what the owner asked to be rid of.
for (const ev of ['mouseenter', 'focus']) {
    el('stl-water').addEventListener(ev, () => flashWaterInfo());
}

let waterInfoTimer = null;
function flashWaterInfo() {
    const n = el('water-info');
    updateWaterInfo();
    n.className = 'show';
    // Track the thumb: the slider runs bottom (0) to top (1000), inset by the
    // same padding at each end.
    if (n.style) n.style.bottom = (6 + 0.86 * (num('stl-water', 0) / 10)) + '%';
    if (waterInfoTimer) clearTimeout(waterInfoTimer);
    waterInfoTimer = setTimeout(() => { n.className = ''; }, 1600);
}

el('stl-water').addEventListener('input', () => {
    flashWaterInfo();
    if (!Mesh) return;
    try { captureDepth(); refreshExportSizes(); } catch (e) { return fail(e); }
    scheduleRun('fit');   // the height field is already rebuilt
});

// A 0-1000 slider position means nothing. The slider sets a height, so the
// height is the figure that leads; the percentage is derived from it and the
// model's current extent along the water normal.
//
// That percentage moving while the plane stays put is correct, and is the whole
// point of an absolute cut-off: tipping an object in standing water really does
// change how much of it is under. The number that must not move is the height.
function updateWaterInfo() {
    const n = el('water-info');
    if (!Mesh) { n.textContent = 'Keeps the whole model'; return; }
    const ext = captureExtent();
    const kept = ext.hi[2] - Math.max(waterLevel(), ext.lo[2]);
    const total = Math.max(1e-12, ext.hi[2] - ext.lo[2]);
    const pct = Math.round(100 * Math.max(0, kept) / total);
    n.textContent = kept <= 0
        ? 'Nothing left above the cut-off'
        : `Keeps the top ${kept.toFixed(2)} mm \u2014 ${pct}% of the model`;
}

// Depth render along the CAPTURE axis + water threshold + commit as the height
// field. There is no separate "use this" step: the depth map IS the input.
function captureDepth() {
    if (!Mesh) return;
    const n = autoResolution(Mesh.count);
    const rot = STL.transformVerts(Mesh.verts, CapM, Mesh.bounds.center);

    Depth = STL.depthRender(rot, n, n, {});

    // applyWater takes a fraction of the depth render's own z range; the
    // slider is an absolute height, so convert here rather than let a fraction
    // back into the model. Out-of-range clamps: below the mesh keeps all of it,
    // above the mesh leaves nothing and raises the inline error below.
    const zSpan = Math.max(1e-12, Depth.zmax - Depth.zmin);
    const water = STL.applyWater(Depth, (waterLevel() - Depth.zmin) / zSpan);
    Depth.water = water;
    ErrField = null;
    updateWaterInfo();     // the mm figure needs the render's z range
    drawPreview();

    el('stl-info').textContent =
        `${FileName} \u2014 ${Mesh.count.toLocaleString()} triangles`;

    if (water.above < 64) {
        throw where('water', new Error(
            'Almost nothing is above the cut-off \u2014 lower it.'));
    }
    commitDepth(water);
}

function commitDepth(water) {
    const { W, H } = Depth;
    const grey = new Float64Array(W * H);
    for (let i = 0; i < W * H; i++) grey[i] = water.mask[i] ? water.zn[i] * 255 : 0;

    ErrField = null;
    Input = {
        W, H, grey, z: water.zn, mask: water.mask,
        maskInfo: { mask: water.mask, count: water.above, rule: 'above water line' },
        contour: CONTOUR.traceContour(water.mask, W, H),
        unitScale: water.unitScale, unitName: 'mm', source: 'stl',
        // Real model dimensions: the normalised patch square spans exactly
        // these many model units in x and y, and this much relief in z.
        sizeX: Depth.modelWidth, sizeY: Depth.modelHeight, height: water.span,
        scaleNote: 'From the STL. Edit any of them to resize the output.',
    };

    // preview only -- the fit reads Input.z, not these pixels
    setSize(InputCtx, W, H);
    const img = InputCtx.createImageData(W, H);
    const d = img.data;
    for (let i = 0; i < W * H; i++) {
        const t = Math.round(Math.max(0, Math.min(1, water.zn[i])) * 255);
        d[4 * i] = d[4 * i + 1] = d[4 * i + 2] = water.mask[i] ? t : 0;
        d[4 * i + 3] = 255;
    }
    InputCtx.putImageData(img, 0, 0);
    drawMask();

    // Reaching here means a height field was committed, whatever route got us
    // here. Without this a capture that failed (a drag that lifted the model
    // clear of the cut-off) left `input` marked stale, and recovering through
    // the slider -- which only schedules from `fit` -- never cleared it, so the
    // status line said "updating..." for the rest of the session.
    state.input = 'ok';
}

// ============================================================= the previews
// Both panes are drawn by the same small z-buffer rasteriser, from the same
// camera. That is not a saving, it is the point: the left pane is the model
// with the cut-off plane in it, the right pane is the surface that came out,
// and they only read as one scene if they are one scene.
//
// This lives here rather than in stl.js because it does something depthRender
// deliberately does not: it draws from the CAMERA while colouring every
// fragment by its height along the CAPTURE axis. Those being different axes is
// how the cut-off becomes visible as a plane instead of as a slider position.

// Extent of the mesh along the CURRENT capture axis, straight off the vertices.
// The preview needs this every frame while the cut-off is being tilted, and it
// must not have to wait for a depth render to get it, so it does not go through
// Depth at all. Cached per capture orientation.
let CapExtent = null, CapExtentKey = '';
function captureExtent() {
    const key = CapM.join(',');
    if (CapExtent && CapExtentKey === key) return CapExtent;
    const M = CapM, V = Mesh.verts;
    const [cx, cy, cz] = Mesh.bounds.center;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < V.length; i += 3) {
        const x = V[i] - cx, y = V[i + 1] - cy, z = V[i + 2] - cz;
        const q = [M[0] * x + M[1] * y + M[2] * z,
                   M[3] * x + M[4] * y + M[5] * z,
                   M[6] * x + M[7] * y + M[8] * z];
        for (let k = 0; k < 3; k++) {
            if (q[k] < lo[k]) lo[k] = q[k];
            if (q[k] > hi[k]) hi[k] = q[k];
        }
    }
    CapExtentKey = key;
    CapExtent = { lo, hi, size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] };
    return CapExtent;
}

// depthRender's framing, recovered so a capture-space point can be turned into
// a pixel of the height field and back. Derived from what depthRender returns
// (Depth.bounds, W, H) rather than read out of stl.js, which stays untouched.
function captureFrame() {
    const b = Depth.bounds, W = Depth.W, H = Depth.H, margin = 2;
    const spanX = b.size[0] || 1, spanY = b.size[1] || 1;
    const uW = Math.max(1, W - 2 * margin), uH = Math.max(1, H - 2 * margin);
    const s = Math.min(uW / spanX, uH / spanY);
    return {
        s, W, H,
        ox: margin + (uW - spanX * s) / 2 - b.lo[0] * s,
        oy: margin + (uH - spanY * s) / 2 - b.lo[1] * s,
    };
}

// ------------------------------------------------------------- rasteriser

function newRaster(N) {
    const px = new Uint8ClampedArray(N * N * 4);
    for (let i = 0; i < N * N; i++) {
        const chk = (((i % N) >> 2) + ((i / N | 0) >> 2)) & 1;
        px[4 * i] = px[4 * i + 1] = px[4 * i + 2] = chk ? 48 : 40;
        px[4 * i + 3] = 255;
    }
    return { N, px, zbuf: new Float64Array(N * N).fill(-Infinity) };
}

function flushRaster(ctx, R) {
    setSize(ctx, R.N, R.N);
    const img = ctx.createImageData(R.N, R.N);
    img.data.set(R.px);
    ctx.putImageData(img, 0, 0);
}

// Screen positions sx/sy and camera depths ez for one triangle; `shade` fills
// RGB for the fragment at the given barycentric weights. Nearest surface wins.
const RGB = new Float64Array(3);
function rasterTri(R, sx, sy, ez, shade) {
    const N = R.N;
    const det = (sy[1] - sy[2]) * (sx[0] - sx[2]) + (sx[2] - sx[1]) * (sy[0] - sy[2]);
    if (Math.abs(det) < 1e-12) return;
    const x0 = Math.max(0, Math.floor(Math.min(sx[0], sx[1], sx[2])));
    const x1 = Math.min(N - 1, Math.ceil(Math.max(sx[0], sx[1], sx[2])));
    const y0 = Math.max(0, Math.floor(Math.min(sy[0], sy[1], sy[2])));
    const y1 = Math.min(N - 1, Math.ceil(Math.max(sy[0], sy[1], sy[2])));
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            const l1 = ((sy[1] - sy[2]) * (x - sx[2]) + (sx[2] - sx[1]) * (y - sy[2])) / det;
            const l2 = ((sy[2] - sy[0]) * (x - sx[2]) + (sx[0] - sx[2]) * (y - sy[2])) / det;
            const l3 = 1 - l1 - l2;
            if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
            const dv = l1 * ez[0] + l2 * ez[1] + l3 * ez[2];
            const idx = y * N + x;
            if (dv <= R.zbuf[idx]) continue;
            R.zbuf[idx] = dv;
            shade(l1, l2, l3);
            R.px[4 * idx] = RGB[0]; R.px[4 * idx + 1] = RGB[1]; R.px[4 * idx + 2] = RGB[2];
        }
    }
}

// Depth-tested but not depth-writing: used for the translucent cut-off plane,
// which must go behind the model rather than float in front of it.
function blendTri(R, sx, sy, ez, rgb, alpha, av) {
    const N = R.N;
    const det = (sy[1] - sy[2]) * (sx[0] - sx[2]) + (sx[2] - sx[1]) * (sy[0] - sy[2]);
    if (Math.abs(det) < 1e-12) return;
    const x0 = Math.max(0, Math.floor(Math.min(sx[0], sx[1], sx[2])));
    const x1 = Math.min(N - 1, Math.ceil(Math.max(sx[0], sx[1], sx[2])));
    const y0 = Math.max(0, Math.floor(Math.min(sy[0], sy[1], sy[2])));
    const y1 = Math.min(N - 1, Math.ceil(Math.max(sy[0], sy[1], sy[2])));
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            const l1 = ((sy[1] - sy[2]) * (x - sx[2]) + (sx[2] - sx[1]) * (y - sy[2])) / det;
            const l2 = ((sy[2] - sy[0]) * (x - sx[2]) + (sx[0] - sx[2]) * (y - sy[2])) / det;
            const l3 = 1 - l1 - l2;
            if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
            const dv = l1 * ez[0] + l2 * ez[1] + l3 * ez[2];
            const idx = y * N + x;
            if (dv <= R.zbuf[idx]) continue;
            // Per-vertex alpha, interpolated: how the plane's rim fades out
            // instead of ending at an edge.
            const a = av ? alpha * (l1 * av[0] + l2 * av[1] + l3 * av[2]) : alpha;
            if (a <= 0.002) continue;
            for (let k = 0; k < 3; k++) {
                R.px[4 * idx + k] = R.px[4 * idx + k] * (1 - a) + rgb[k] * a;
            }
        }
    }
}

// The one length in this file that CANNOT change when the model turns: half
// the bounding-box diagonal, i.e. the radius of the mesh's bounding sphere,
// taken from the untransformed vertices once per file. Every drawn size and
// the view scale come from this. Extent measured along the current capture
// axis (captureExtent) does change with orientation, and using it to size
// anything drawn is exactly the bug this replaced: the cut-off plane grew,
// shrank and re-cornered itself as the object tipped, which made it read as
// attached to the object and made the whole view appear to zoom.
function meshRadius() {
    return 0.5 * Math.hypot(Mesh.bounds.size[0], Mesh.bounds.size[1],
                            Mesh.bounds.size[2]) || 1;
}

// One camera for both panes, at one fixed scale -- so orbiting never resizes
// anything, tipping the model never resizes anything, and the fitted surface
// comes out the same size as the model it was fitted to.
// Zoom is a property of the SHARED camera, exactly like its orientation: one
// value, applied to both panes, and a gesture on either canvas moves both.
// Per-pane zoom would break the thing §15.4 is for -- the surface comes out the
// same size, in the same place, as the model it was fitted to, so the two panes
// read as one scene seen from one place.
//
// It multiplies the projector's scale and nothing else. `rad` stays the world
// radius, because the one thing derived from it that is not a screen size is
// drawSurfaceGrid's depth bias, which is in world units and must not move.
const ZOOM_MIN = 0.4, ZOOM_MAX = 8;
let Zoom = 1;

function projector(N) {
    const rad = meshRadius();
    // The margin is a fraction, not 8 px: the framing must be identical at
    // every resolution, or refining after a drag would resize the picture.
    const half = N / 2, k = half * 0.94 * Zoom / rad;
    return { N, rad, k, toX: (x) => half + x * k, toY: (y) => half - y * k };
}

// ------------------------------------------------------- the cut-off height
// The slider sets an ABSOLUTE height in the water frame, not a fraction of the
// model's extent. Standing water does not move when you tip something in it,
// and a fraction of a per-orientation extent does exactly that: the same slider
// position would mean a different world height at every angle. So the range is
// fixed per file, from the one orientation-invariant length there is: the plane
// can stand anywhere from a radius below the model's centre to a radius above
// it, which covers the model at every possible orientation.
//
// The travel at each end where the water is clear of the model is not wasted:
// the plane is visibly standing above or below the object, which is the honest
// picture of what that setting means.
// The height -> grey ramp's range, and it is the SAME range the slider spans.
// It must not come from the model's extent along the current capture axis:
// that moves when the cut-off moves (the range above the water shrinks as the
// water rises) and again when the object turns, so the whole model silently
// changed shade whenever the user touched a control that should only have
// changed where the blue starts. Both are the same defect -- something inert
// responding to unrelated state -- and both are fixed by normalising against a
// quantity that cannot move. Lambert shading is left alone: that SHOULD change
// as the object turns, because it is light falling on a turning surface, and it
// is what gives the pane its form.
function shadeRange() {
    const r = meshRadius();
    return { lo: -r, span: 2 * r };
}

function waterLevel() {
    const r = meshRadius();
    return -r + 2 * r * Math.max(0, Math.min(1, num('stl-water', 0) / 1000));
}

// The inverse, used once per file to park the slider on the model's underside
// so a fresh drop keeps the whole model with the plane touching its base.
function waterSlider(level) {
    const r = meshRadius();
    return Math.max(0, Math.min(1000, Math.round(1000 * (level + r) / (2 * r))));
}

const lambert = (ax, ay, az, bx, by, bz) => {
    const nz = ax * by - ay * bx;
    const nl = Math.hypot(ay * bz - az * by, az * bx - ax * bz, nz) || 1;
    return 0.42 + 0.58 * Math.abs(nz / nl);
};

// ------------------------------------------------- left pane: the model

function drawPreview() {
    if (!Mesh) return;
    const N = previewSize('stl-canvas');
    const R = newRaster(N);
    const P = projector(N);

    const Mc = viewM(), Mk = CapM;
    const [cx, cy, cz] = Mesh.bounds.center;
    const V = Mesh.verts;

    // Nothing drawn in this pane is derived from captureExtent() any more --
    // not its geometry and not its colour. The extent is a pipeline quantity
    // (the readout's percentage, and the depth render) and it stays there.
    const level = waterLevel();
    const sr = shadeRange();

    const ex = new Float64Array(3), ey = new Float64Array(3), ez = new Float64Array(3);
    const qz = new Float64Array(3);
    const sx = new Float64Array(3), sy = new Float64Array(3);
    let lam = 1;

    // Each vertex carries its camera-space position (picture + depth test) AND
    // its height along the capture axis (the cut-off test); both are
    // interpolated barycentrically in the same pass.
    const shade = (l1, l2, l3) => {
        const h = l1 * qz[0] + l2 * qz[1] + l3 * qz[2];
        // One fixed ramp for both sides of the cut-off, so the only thing the
        // slider changes is WHICH fragments are tinted -- which is all it means.
        const u = Math.max(0, Math.min(1, (h - sr.lo) / sr.span));
        let r, g, b;
        if (h <= level) {
            // below the cut-off: the part that is thrown away
            r = 20 + 30 * u; g = 60 + 60 * u; b = 110 + 90 * u;
        } else {
            r = g = b = 20 + u * 235;
        }
        RGB[0] = r * lam; RGB[1] = g * lam; RGB[2] = b * lam;
    };

    for (let t = 0; t < V.length; t += 9) {
        for (let j = 0; j < 3; j++) {
            const x = V[t + j * 3] - cx, y = V[t + j * 3 + 1] - cy, z = V[t + j * 3 + 2] - cz;
            ex[j] = Mc[0] * x + Mc[1] * y + Mc[2] * z;
            ey[j] = Mc[3] * x + Mc[4] * y + Mc[5] * z;
            ez[j] = Mc[6] * x + Mc[7] * y + Mc[8] * z;
            qz[j] = Mk[6] * x + Mk[7] * y + Mk[8] * z;
            sx[j] = P.toX(ex[j]); sy[j] = P.toY(ey[j]);
        }
        lam = lambert(ex[1] - ex[0], ey[1] - ey[0], ez[1] - ez[0],
                      ex[2] - ex[0], ey[2] - ey[0], ez[2] - ez[0]);
        rasterTri(R, sx, sy, ez, shade);
    }

    drawCutPlane(R, P, Mc, Mk, level);
    flushRaster(StlCtx, R);
}

// The error palette. Diverging, multi-hue, neutral at zero: warm (amber ->
// orange -> red) where the fitted surface sits ABOVE the mesh, cool (pale cyan
// -> blue -> deep blue) where it sits below, near-white in between.
//
// Multi-hue on each arm rather than one colour fading out, because a two-tone
// fade puts all its information in saturation, and saturation is the channel
// the eye is worst at reading -- exactly where a fit is nearly right, which is
// where the interesting structure is. Hue separates the two directions even at
// low magnitude: the midpoint reads as "no error" while a hair above it is
// already recognisably warm and a hair below already recognisably cool.
const ERR_STOPS = [
    [-1.00, [ 38,  56, 138]],
    [-0.66, [ 42, 116, 196]],
    [-0.33, [126, 188, 226]],
    [ 0.00, [244, 244, 238]],
    [ 0.33, [248, 202, 118]],
    [ 0.66, [232, 130,  58]],
    [ 1.00, [168,  32,  32]],
];

function diverging(e) {
    const t = Math.max(-1, Math.min(1, e));
    for (let i = 1; i < ERR_STOPS.length; i++) {
        if (t > ERR_STOPS[i][0] && i < ERR_STOPS.length - 1) continue;
        const [t0, c0] = ERR_STOPS[i - 1], [t1, c1] = ERR_STOPS[i];
        const f = (t - t0) / (t1 - t0);
        return [c0[0] + f * (c1[0] - c0[0]),
                c0[1] + f * (c1[1] - c0[1]),
                c0[2] + f * (c1[2] - c0[2])];
    }
    return ERR_STOPS[3][1].slice();
}

// The cut-off drawn where it actually is: a level surface perpendicular to the
// water normal, at the height the slider sets, and NOTHING else about it moves.
//
// It is a disc, not a quad, and it is deliberately bigger than the model. Two
// separate mistakes were in the rectangle it replaced: it was sized from the
// mesh's bounds along the current capture axis, so it changed size and shape on
// every left drag; and it had four corners sitting close to the object, which
// is what made it read as a lid fitted to the model rather than as water the
// model is standing in. A disc has no corners, and its rim fades out over a
// wide band, so the surface reads as continuing past the frame instead of
// ending. Radius comes from the bounding sphere: it cannot change under
// rotation. In the default straight-down view the disc runs past every edge of
// the canvas, which is the point.
const PLANE_SOLID = 0.95;   // radii of the bounding sphere: full strength out to here
const PLANE_EDGE = 1.75;    // ... fading to nothing out here
const PLANE_SEGMENTS = 48;

// ONE treatment, at all times. On load the cut-off is parked under the model
// and is discarding nothing, so it must look like it is doing nothing: quiet
// furniture, behind the object in visual priority, the model the subject. And
// it must not restyle itself when it starts cutting -- the blue tint on the
// discarded geometry already says that, it appears exactly when the cut-off
// starts doing something, and it is attached to the thing being affected. A
// second, state-dependent restyle would be one more thing changing appearance
// in response to state the user is not thinking about, which is the defect this
// pane has repeatedly been caught with.
//
// So: neutral grey, no tint. Blue in this pane means "discarded", and it means
// only that.
const PLANE_RGB = [150, 158, 168];
const PLANE_ALPHA = 0.13;
const GRID_RGB = [198, 203, 210];
const GRID_ALPHA = 0.22;
// Grid spacing, in radii of the bounding sphere. Coarse on purpose: about four
// cells across the model. A fine grid turns to moire at a glancing angle, which
// is precisely the angle the grid exists for.
const PLANE_GRID = 0.5;

// Where the plane landed on screen, recorded for the test suite: a left drag
// must not move any of these numbers.
let LastPlane = null;

// The grid's world geometry: lines of constant u and constant v in the WATER's
// own frame, at the height the slider sets. Spacing and origin come from the
// bounding sphere and the mesh centre, so nothing here depends on which way the
// object is facing -- turn the model and not one of these numbers moves. Only
// the height does.
function waterGridSpec() {
    const rad = meshRadius();
    const spacing = PLANE_GRID * rad, outer = PLANE_EDGE * rad, level = waterLevel();
    const n = Math.floor(outer / spacing);
    // water frame -> world (WaterM is orthonormal, so transpose)
    const M = WaterM;
    const world = (u, v) => [M[0] * u + M[3] * v + M[6] * level,
                             M[1] * u + M[4] * v + M[7] * level,
                             M[2] * u + M[5] * v + M[8] * level];
    return { spacing, outer, level, n, world };
}

function drawCutPlane(R, P, Mc, Mk, level) {
    const rad = meshRadius();
    const inner = PLANE_SOLID * rad, outer = PLANE_EDGE * rad;

    // capture space (u, v, level) -> model space (Mk is orthonormal) -> camera
    const pt = (u, v) => {
        const x = Mk[0] * u + Mk[3] * v + Mk[6] * level;
        const y = Mk[1] * u + Mk[4] * v + Mk[7] * level;
        const z = Mk[2] * u + Mk[5] * v + Mk[8] * level;
        return [P.toX(Mc[0] * x + Mc[1] * y + Mc[2] * z),
                P.toY(Mc[3] * x + Mc[4] * y + Mc[5] * z),
                Mc[6] * x + Mc[7] * y + Mc[8] * z];
    };

    // Recorded as a fraction of the raster, not in pixels: the raster changes
    // size with the window and between a drag frame and its refinement, and
    // what must not move is where the plane sits in the picture.
    const c = pt(0, 0), q = 1 / P.N;
    LastPlane = { cx: c[0] * q, cy: c[1] * q, inner, outer,
                  ux: (pt(inner, 0)[0] - c[0]) * q, uy: (pt(inner, 0)[1] - c[1]) * q,
                  vx: (pt(0, inner)[0] - c[0]) * q, vy: (pt(0, inner)[1] - c[1]) * q };

    const sx = new Float64Array(3), sy = new Float64Array(3), ez = new Float64Array(3);
    const av = new Float64Array(3);
    const rgb = PLANE_RGB;
    const tri = (a, b, d, aa, ab, ad) => {
        sx[0] = a[0]; sy[0] = a[1]; ez[0] = a[2];
        sx[1] = b[0]; sy[1] = b[1]; ez[1] = b[2];
        sx[2] = d[0]; sy[2] = d[1]; ez[2] = d[2];
        av[0] = aa; av[1] = ab; av[2] = ad;
        blendTri(R, sx, sy, ez, rgb, PLANE_ALPHA, av);
    };

    let a0 = pt(inner, 0), b0 = pt(outer, 0);
    for (let k = 1; k <= PLANE_SEGMENTS; k++) {
        const th = 2 * Math.PI * k / PLANE_SEGMENTS;
        const cs = Math.cos(th), sn = Math.sin(th);
        const a1 = pt(inner * cs, inner * sn), b1 = pt(outer * cs, outer * sn);
        tri(c, a0, a1, 1, 1, 1);              // solid core
        tri(a0, a1, b1, 1, 1, 0);             // rim, fading outward
        tri(a0, b1, b0, 1, 0, 0);
        a0 = a1; b0 = b1;
    }

    drawWaterGrid(R, pt, inner, outer);
}

// A flat translucent disc seen edge-on gives the eye nothing to fix on: no
// texture, so no parallax, so no sense of which way it is lying. Its silhouette
// was the only orientation cue, which is why a silhouette that changed with the
// model was so confusing. Converging grid lines read as a receding plane at a
// glance and keep doing so from any camera angle.
//
// Thin, solid, neutral grey: the ground-plane grid of every CAD and 3D tool.
// That is the whole reason for it -- it is recognised rather than read, so it
// says "level reference surface" without anyone having to work it out. It was
// briefly dashed and blue-tinted, which turned furniture into an annotation
// that needed interpreting.
//
// It still has to be told apart from the control grid on the fitted surface,
// which the eye often sees at the same time. Both are solid; they are separated
// by WEIGHT and CONTRAST instead of style. The control grid is dark and firm --
// it halves the pixel under it, on a light surface. This one is the lighter and
// quieter of the two: a pale grey at a fifth alpha over a dark surface. The
// loud one is the one that carries data.
//
// Depth-tested against the model, so the object occludes the lines behind it.
// That occlusion is the strongest depth cue on the pane and it is free.
function drawWaterGrid(R, pt, inner, outer) {
    const g = waterGridSpec();
    const N = R.N;
    const rgb = GRID_RGB;
    // Two samples per pixel at whatever resolution this frame is, so the lines
    // stay solid instead of breaking into dots as the raster grows.
    // Zoom stretches the same world span over more pixels, so the sample
    // rate has to follow it or the grid lines break into dots.
    const step = outer / (2 * N * Zoom);

    const mark = (u, v) => {
        const r = Math.hypot(u, v);
        if (r > outer) return;
        // Fades out over the same band the disc's rim does, so the lines do not
        // outlive the surface they are drawn on.
        const fade = r <= inner ? 1 : Math.max(0, 1 - (r - inner) / (outer - inner));
        if (fade <= 0.02) return;
        const q = pt(u, v);
        const x = Math.round(q[0]), y = Math.round(q[1]);
        if (x < 0 || y < 0 || x >= N || y >= N) return;
        const idx = y * N + x;
        if (q[2] <= R.zbuf[idx]) return;       // behind the model
        const a = GRID_ALPHA * fade;
        for (let k = 0; k < 3; k++) {
            R.px[4 * idx + k] = R.px[4 * idx + k] * (1 - a) + rgb[k] * a;
        }
    };

    for (let i = -g.n; i <= g.n; i++) {
        const c = i * g.spacing;
        const half = Math.sqrt(Math.max(0, outer * outer - c * c));
        for (let t = -half; t <= half; t += step) {
            mark(c, t);
            mark(t, c);
        }
    }
}

// The capture-direction arrow that used to be drawn over this pane is gone. It
// was an annotation with no legend, in a pane that has to read as harmless
// before the user has found anything, and it was redundant: "which way is up
// out of the water" is already told by the plane the model is standing in and
// by the blue on everything under it. If the direction ever needs stating
// again, state it in words next to the slider, not as a glyph on the picture.

// ---------------------------------------------- right pane: the result
// The product, rendered as a solid from the same camera and sitting in the same
// place in space as the model it was fitted to -- so turning the view turns
// both, and the two panes are the same scene.

let ResultGeom = null;   // { kind: 'warp', patch } | { kind: 'grid', grid }, + cells

function setResult(geom) { ResultGeom = geom; drawResult(); }

// The Detail slider IS control-net density, and until now nothing on screen
// said so. These are the isoparametric lines of the control net drawn on the
// surface itself: for the rectangular fit they are the seams between adjacent
// Bezier patches; the outline patch is a single patch with no seams, so it gets
// an isoparametric grid at the same spacing as its control net instead, which
// keeps the slider from being a no-op there. Default on -- it is the feedback
// the slider was missing, not a diagnostic.
const showGrid = installToggle('show-grid', true, () => {
    try { drawResult(); } catch (e) { fail(e); }
});

// Sample counts across the surface. 56 is where a smooth patch stops showing
// facets at 256 px; the grid fallback samples the same way.
const RESULT_STEPS = 56;

function drawResult() {
    if (!Mesh || !ResultGeom || !Depth || !Depth.water || !Input) return;
    const N = previewSize('warp-canvas');
    const R = newRaster(N);
    const P = projector(N);
    // The surface is drawn where it actually sits: it was fitted in capture
    // space, and capture space is the water frame seen from the object, so
    // Mk^T carries it back into model coordinates and Mc puts it on screen in
    // the same place, at the same size, as the mesh in the left pane. At rest
    // the two panes are literally the same scene.
    //
    // Mk is the LIVE capture frame, not the one the fit was taken in. They
    // differ only for the 280 ms of a left drag, and using the live one means
    // the surface holds still while the input is re-aimed rather than tipping
    // and then snapping back when the refit lands. It also matches the emitted
    // OpenSCAD, which is always z-up in the capture frame.
    const Mc = viewM(), Mk = CapM;
    const fr = captureFrame();
    const level = Depth.water.water, span = Depth.water.span;
    const { W, H } = Input;

    // (u,v) over the height field, z normalised 0..1 -> the same model-space
    // point the fit was taken from.
    const S = Math.max(RESULT_STEPS, Math.min(176, Math.round(N * Zoom / 5)));
    const vx = new Float64Array((S + 1) * (S + 1));
    const vy = new Float64Array((S + 1) * (S + 1));
    const vz = new Float64Array((S + 1) * (S + 1));
    const vh = new Float64Array((S + 1) * (S + 1));
    const ve = new Float64Array((S + 1) * (S + 1)).fill(NaN);
    // How much of the error field the sample could actually see, 0..1. Kept
    // separately from the value so the edge of the coloured region can be
    // resolved per fragment instead of per triangle -- see tri()/shade().
    const vc = new Float64Array((S + 1) * (S + 1));
    const ok = new Uint8Array((S + 1) * (S + 1));

    // How far this surface is from the mesh it was fitted to, sampled in the
    // surface's OWN parameter space as it is tessellated -- so the colour is
    // right across the patch rather than smeared by a screen-space lookup. Same
    // field, same sign convention and same 99th-percentile scale as everything
    // else that reports error: computeErrorField() is the only definition.
    const overlay = showErrors() ? errorField() : null;

    // (u,v) over the height field, z normalised 0..1 -> camera space.
    const OUT = new Float64Array(3);
    const toCam = (u, v, z01) => {
        const cxs = (u * (W - 1) - fr.ox) / fr.s;
        const cys = (v * (H - 1) - fr.oy) / fr.s;
        const czs = level + Math.max(0, Math.min(1, z01)) * span;
        const x = Mk[0] * cxs + Mk[3] * cys + Mk[6] * czs;
        const y = Mk[1] * cxs + Mk[4] * cys + Mk[7] * czs;
        const z = Mk[2] * cxs + Mk[5] * cys + Mk[8] * czs;
        OUT[0] = Mc[0] * x + Mc[1] * y + Mc[2] * z;
        OUT[1] = Mc[3] * x + Mc[4] * y + Mc[5] * z;
        OUT[2] = Mc[6] * x + Mc[7] * y + Mc[8] * z;
    };

    // The error where a surface point lands, bilinear over the height field.
    // Nearest-neighbour terraced the colour into field pixels, which are
    // coarser than the tessellation at every detail level -- W is 128..256
    // while the surface is sampled 56..176 across and drawn at up to 1200.
    //
    // ERR[1] is the weight that reached a defined value: 1 well inside the
    // mask, 0 well outside, and a fraction across the boundary. The value is
    // the mean of whichever corners were defined, so the colour does not fade
    // towards zero as the edge is approached; the weight is what says where
    // the edge is, and it is a smooth field rather than a per-pixel yes/no.
    const ERR = new Float64Array(2);
    const errAt = (u, v) => {
        ERR[0] = NaN; ERR[1] = 0;
        if (!overlay) return;
        const fx = Math.max(0, Math.min(W - 1, u * (W - 1)));
        const fy = Math.max(0, Math.min(H - 1, v * (H - 1)));
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
        const tx = fx - x0, ty = fy - y0;
        let sum = 0, wsum = 0;
        for (let k = 0; k < 4; k++) {
            const px = k & 1 ? x1 : x0, py = k & 2 ? y1 : y0;
            const wgt = (k & 1 ? tx : 1 - tx) * (k & 2 ? ty : 1 - ty);
            if (wgt === 0) continue;
            const e = overlay.err[py * W + px];
            if (!Number.isFinite(e)) continue;
            sum += wgt * e; wsum += wgt;
        }
        if (wsum > 0) { ERR[0] = sum / wsum; ERR[1] = wsum; }
    };

    // One parameter pair -> a point on the surface, whichever geometry it is.
    // Returns false outside the mask, which only the rectangular fit has.
    const surfaceAt = (a, b) => {
        if (ResultGeom.kind === 'warp') {
            const q = WARP.patchAt(ResultGeom.patch, a, b);
            toCam(q[0], q[1], q[2]);
            errAt(q[0], q[1]);
            return Math.max(0, Math.min(1, q[2]));
        }
        const px = Math.round(a * (W - 1)), py = Math.round(b * (H - 1));
        if (!Input.mask[py * W + px]) return -1;
        const z01 = ResultGeom.grid[py * W + px];
        toCam(a, b, z01);
        errAt(a, b);
        return Math.max(0, Math.min(1, z01));
    };

    for (let j = 0; j <= S; j++) {
        for (let i = 0; i <= S; i++) {
            const idx = j * (S + 1) + i;
            const h = surfaceAt(i / S, j / S);
            if (h < 0) continue;
            vx[idx] = OUT[0]; vy[idx] = OUT[1]; vz[idx] = OUT[2];
            vh[idx] = h; ve[idx] = ERR[0]; vc[idx] = ERR[1]; ok[idx] = 1;
        }
    }

    const sx = new Float64Array(3), sy = new Float64Array(3), ez = new Float64Array(3);
    const hh = new Float64Array(3), ee = new Float64Array(3), cc = new Float64Array(3);
    let lam = 1, painted = false;
    const shade = (l1, l2, l3) => {
        // Per fragment, not per triangle. The coloured region ends where the
        // interpolated coverage crosses a half, which is a curve through the
        // triangle rather than the triangle's own outline -- so the edge of
        // the overlay is drawn at pixel resolution instead of stepping down
        // the tessellation grid.
        if (painted && l1 * cc[0] + l2 * cc[1] + l3 * cc[2] >= 0.5) {
            const e = l1 * ee[0] + l2 * ee[1] + l3 * ee[2];
            const col = diverging(e / overlay.scale);
            RGB[0] = col[0] * lam; RGB[1] = col[1] * lam; RGB[2] = col[2] * lam;
            return;
        }
        const u = l1 * hh[0] + l2 * hh[1] + l3 * hh[2];
        RGB[0] = RGB[1] = RGB[2] = (20 + u * 235) * lam;
    };

    const tri = (a, b, c) => {
        if (!ok[a] || !ok[b] || !ok[c]) return;
        const idx = [a, b, c];
        let seen = 0, mean = 0;
        for (let j = 0; j < 3; j++) {
            sx[j] = P.toX(vx[idx[j]]); sy[j] = P.toY(vy[idx[j]]);
            ez[j] = vz[idx[j]]; hh[j] = vh[idx[j]];
            ee[j] = ve[idx[j]]; cc[j] = vc[idx[j]];
            if (cc[j] > 0) { seen++; mean += ee[j]; }
        }
        // A triangle straddling the edge is drawn, not skipped: shade() decides
        // per fragment which side of it each pixel is on. A corner that saw
        // nothing takes the mean of the corners that did, so the interpolation
        // has a number to work with instead of dragging the colour to zero.
        painted = !!overlay && seen > 0;
        if (painted && seen < 3) {
            mean /= seen;
            for (let j = 0; j < 3; j++) if (!(cc[j] > 0)) ee[j] = mean;
        }
        lam = lambert(vx[b] - vx[a], vy[b] - vy[a], vz[b] - vz[a],
                      vx[c] - vx[a], vy[c] - vy[a], vz[c] - vz[a]);
        rasterTri(R, sx, sy, ez, shade);
    };

    for (let j = 0; j < S; j++) {
        for (let i = 0; i < S; i++) {
            const p = j * (S + 1) + i;
            tri(p, p + 1, p + S + 2);
            tri(p, p + S + 2, p + S + 1);
        }
    }

    if (showGrid()) drawSurfaceGrid(R, P, surfaceAt, OUT);
    flushRaster(WarpCtx, R);
    updateLegend(overlay);
}

// Drawn against the z-buffer that was just filled, not over the top of it, so
// the lines sit ON the surface and vanish where it curves away. They darken
// whatever colour is already there, which keeps them quiet and keeps them
// legible over any shading.
function drawSurfaceGrid(R, P, surfaceAt, OUT) {
    const cells = Math.max(1, Math.min(48, Math.round(ResultGeom.cells || 4)));
    const steps = Math.max(6 * RESULT_STEPS, Math.round(2 * R.N * Zoom));
    // The line samples sit on the true surface; the raster underneath is its
    // linear tessellation, so allow a hair of depth slack before rejecting.
    const bias = 0.01 * P.rad;
    const mark = (a, b) => {
        if (surfaceAt(a, b) < 0) return;
        const x = Math.round(P.toX(OUT[0])), y = Math.round(P.toY(OUT[1]));
        if (x < 0 || y < 0 || x >= R.N || y >= R.N) return;
        const idx = y * R.N + x;
        if (!Number.isFinite(R.zbuf[idx]) || OUT[2] < R.zbuf[idx] - bias) return;
        // Halving the pixel underneath is enough on the plain grey shading, but
        // the error palette runs from near-white to a deep blue that a further
        // halving turns into black-on-dark. So the line goes the other way on
        // anything already dark: down towards black on light colours, up towards
        // white on dark ones. Same line weight, same visual quietness, readable
        // over every part of the palette.
        const lum = 0.299 * R.px[4 * idx] + 0.587 * R.px[4 * idx + 1] +
                    0.114 * R.px[4 * idx + 2];
        for (let k = 0; k < 3; k++) {
            R.px[4 * idx + k] = lum < 96
                ? R.px[4 * idx + k] * 0.45 + 225 * 0.55
                : R.px[4 * idx + k] * 0.5;
        }
    };
    for (let c = 0; c <= cells; c++) {
        const t = c / cells;
        for (let k = 0; k <= steps; k++) {
            mark(k / steps, t);
            mark(t, k / steps);
        }
    }
}

// ------------------------------------------------------------------ drag
// The mode is implied by where you drag, so there is no mode to read and no way
// to be in the wrong one: the left pane aims the cut-off, the right pane moves
// the camera that both panes share.

function installOrbit() {
    const left = el('stl-canvas'), right = el('warp-canvas');
    if (!left || !left.addEventListener || !right || !right.addEventListener ||
        typeof window === 'undefined' || !window.addEventListener) return;
    // Pointer events, not mouse events: a finger raises no mousedown/mousemove
    // pair on any current mobile browser, so a mouse-only orbit is not a
    // degraded rotation on a phone, it is no rotation at all -- the drag falls
    // through to the page and scrolls it. `touch-action: none` on .preview is
    // the other half: without it the browser claims the gesture as a scroll
    // before the second pointermove ever arrives.
    let target = null, id = null, lx = 0, ly = 0;
    const release = () => {
        target = null; id = null;
        if (!Dragging) return;
        Dragging = false;
        redrawPreviews();      // the settled frame, at full resolution
    };
    const grab = (which) => (e) => {
        // A second finger means the pinch in installZoom() owns the gesture:
        // one finger cannot both rotate and zoom, and rotating off one of the
        // two pinch fingers spins the model while it scales. isPrimary is the
        // browser's own answer to "is this the finger that started this
        // gesture", which beats counting pointers ourselves -- a single
        // pointerup lost to a backgrounded tab would leave a count that never
        // came down and a pane that never rotated again.
        if (e.pointerType === 'touch' && e.isPrimary === false) { release(); return; }
        target = which; id = e.pointerId; lx = e.clientX; ly = e.clientY;
        Dragging = true;
    };
    left.addEventListener('pointerdown', grab('object'));
    right.addEventListener('pointerdown', grab('camera'));
    const up = (e) => {
        if (e && id !== null && e.pointerId !== undefined && e.pointerId !== id) return;
        release();
    };
    window.addEventListener('pointerup', up);
    // A touch drag that leaves the canvas, or that the browser takes over,
    // ends as a cancel and never as an up. Without this the pane stays stuck
    // in its low-resolution drag frame.
    window.addEventListener('pointercancel', up);
    window.addEventListener('pointermove', (e) => {
        if (!target || !Mesh) return;
        if (id !== null && e.pointerId !== undefined && e.pointerId !== id) return;
        const dx = e.clientX - lx, dy = e.clientY - ly;
        lx = e.clientX; ly = e.clientY;
        dragBy(target, dx, dy);
    });
}
installOrbit();

// ------------------------------------------------------------------ zoom
// Standard browser inputs only; no gesture recognition of our own beyond
// reading two pointers apart.
//
// On a Mac trackpad a two-finger slide arrives as a `wheel` event and a pinch
// arrives as a `wheel` event with ctrlKey set -- the browser's own convention,
// not a hack. Both mean zoom here, which is what the owner asked for, and a
// mouse wheel then works with no extra case.
//
// Zoom is about the pane CENTRE, not the pointer. Anchored zoom needs a pan
// offset, and with no pan gesture to go with it a user could zoom into a corner
// and strand the model off-screen with only Reset view to get back. That is a
// product reason, not a cost one.
function installZoom() {
    const panes = [el('stl-canvas'), el('warp-canvas')];
    if (panes.some((c) => !c || !c.addEventListener)) return;

    const by = (factor) => {
        const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Zoom * factor));
        if (z === Zoom) return;
        Zoom = z;
        // Camera only: it never re-aims the capture axis, so it never reruns
        // the pipeline. Same contract as a right drag.
        afterCameraMove();
    };

    for (const c of panes) {
        // { passive: false } or the preventDefault() is ignored and the page
        // scrolls under the gesture. The listener is on the canvas alone, so
        // a wheel anywhere else still scrolls normally.
        c.addEventListener('wheel', (e) => {
            if (!Mesh) return;
            if (e.preventDefault) e.preventDefault();
            // deltaMode 1 is lines, 2 is pages; only 0 is already pixels.
            const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
            const d = (e.deltaY || 0) * unit;
            // A pinch reports much smaller deltas than a wheel notch for the
            // same intent, so it gets the larger constant.
            by(Math.exp(-d * (e.ctrlKey ? 0.01 : 0.0025)));
        }, { passive: false });

        // Touch pinch: two live pointers, and the ratio of their separation.
        const live = new Map();
        let apart = 0;
        const spread = () => {
            const p = [...live.values()];
            return p.length === 2 ? Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) : 0;
        };
        c.addEventListener('pointerdown', (e) => {
            if (e.pointerType !== 'touch') return;
            live.set(e.pointerId, { x: e.clientX, y: e.clientY });
            apart = spread();
        });
        c.addEventListener('pointermove', (e) => {
            if (!live.has(e.pointerId)) return;
            live.set(e.pointerId, { x: e.clientX, y: e.clientY });
            const now = spread();
            if (!apart || !now) return;
            if (e.preventDefault) e.preventDefault();
            by(now / apart);
            apart = now;
        });
        const drop = (e) => {
            if (!live.delete(e.pointerId)) return;
            apart = spread();
        };
        c.addEventListener('pointerup', drop);
        c.addEventListener('pointercancel', drop);
    }
}
installZoom();

function redrawPreviews() {
    if (!Mesh) return;
    try { drawPreview(); drawResult(); } catch (e) { fail(e); }
}

// The backing store is sized from the CSS box, so a window resize -- or a drag
// between monitors of different pixel density -- means the previews are the
// wrong size until they are drawn again. previewSize() re-measures on every
// draw, so this only has to ask for one.
if (typeof window !== 'undefined' && window.addEventListener) {
    let resizeTimer = null;
    const onResize = () => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => { resizeTimer = null; redrawPreviews(); }, 120);
    };
    window.addEventListener('resize', onResize);
    if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(onResize);
        ro.observe(el('stl-canvas'));
        ro.observe(el('warp-canvas'));
    }
}

// A drag delta as a rotation in CAMERA space: horizontal spins about the
// screen's vertical axis, vertical about the screen's horizontal one. Both
// drags use the same delta, so whatever is being turned follows the cursor by
// the same amount in either pane -- only WHICH thing turns differs.
const RAD = Math.PI / 180;
function dragBy(target, dx, dy) {
    const D = mul3(rotX(dy * 0.8 * RAD), rotY(dx * 0.8 * RAD));

    if (target === 'camera') {
        CamM = mul3(D, CamM);
        return afterCameraMove();
    }

    // Left drag: turn the OBJECT, in the world, by the rotation that shows up on
    // screen as D. D is expressed in camera space, so it has to be carried back
    // into world space first: CamM^T D CamM. Then
    //     CamM * ObjM' = CamM * CamM^T * D * CamM * ObjM = D * (CamM * ObjM),
    // i.e. the model turns under the cursor exactly as it would in a right drag.
    // The camera is not touched. The water is not touched. The capture axis
    // follows because it is derived from the object.
    ObjM = mul3(mul3(tr3(CamM), mul3(D, CamM)), ObjM);
    deriveCapture();

    // The cut-off follows at once -- drawPreview reads the capture extent
    // straight off the mesh, so it does not wait for a depth render. The
    // pipeline waits for the usual debounce, and restarts from 'input' because
    // the orthographic axis has moved.
    try { drawPreview(); drawResult(); } catch (err) { return fail(err); }
    scheduleRun('input');
}

// ========================================================= error colormap
// Optional, off by default, and a working view rather than a diagnostic: it
// answers "where is this not following my model, and which way".
//
// It paints the FITTED SURFACE, in the right-hand pane. That is the object
// whose accuracy is in question and the one the user is judging; painting the
// error onto the input mesh instead (which is where this started) asks them to
// read the output's fault off the input. There is one such control, in one
// place, for that reason.

const showErrors = installToggle('show-errors', false, () => {
    ErrField = null;
    updateLegend(showErrors() ? errorField() : null);
    try { drawResult(); } catch (e) { fail(e); }
});

// Cached per fit. Null entries are pixels outside the mask, where there is no
// fitted surface to compare against.
function errorField() {
    if (ErrField) return ErrField;
    if (!Input || !LastFit) return null;
    // The error of the surface that is ON SCREEN: the outline patch when that
    // is what was emitted, the rectangular fit when the warp fell back to it.
    // Painting stage 1's error onto the outline patch would put a number on the
    // bar that belongs to a surface nobody is looking at.
    ErrField = (LastWarp && !usingFallback)
        ? computeErrorField(LastWarp.ras.z, LastWarp.ras.cov)
        : computeErrorField(LastFit.grid);
    return ErrField;
}

function computeErrorField(grid, cov) {
    const { W, H, z, mask } = Input;
    const err = new Float64Array(W * H).fill(NaN);
    const abs = [];
    for (let i = 0; i < W * H; i++) {
        if (!mask[i]) continue;
        if (cov && !cov[i]) continue;      // the patch does not reach this pixel
        err[i] = (grid[i] - z[i]) * uScale();
        abs.push(Math.abs(err[i]));
    }
    // 99th percentile, so a few outliers do not flatten the map
    abs.sort((a, b) => a - b);
    const scale = Math.max(1e-9, abs.length ? abs[Math.floor(0.99 * (abs.length - 1))] : 1);
    return { err, scale };
}

// A colour scale explained in a sentence makes the reader assemble the mapping
// in their head; a colour bar IS the mapping, shown. It is also the convention
// for exactly this, so it needs no explaining -- the same reason the water grid
// went back to being a plain CAD grid.
//
// The strip is rasterised from diverging() itself, never from a CSS gradient
// approximating it: an approximation drifts the moment the palette changes and
// the legend starts lying. Warm at the top, matching "warm = above your model".
// CSS size of the strip; its backing store is this times the pixel ratio, for
// the same reason the previews are -- it sits right beside them.
const BAR_W = 12, BAR_H = 160;

function drawColorBar(scale) {
    const dpr = Math.max(1, Math.min(3, (typeof window !== 'undefined' &&
        window.devicePixelRatio) || 1));
    const w = Math.round(BAR_W * dpr), h = Math.round(BAR_H * dpr);
    setSize(BarCtx, w, h);
    const img = BarCtx.createImageData(w, h);
    const d = img.data;
    for (let y = 0; y < h; y++) {
        const col = diverging(1 - 2 * (y / (h - 1)));
        for (let x = 0; x < w; x++) {
            const i = 4 * (y * w + x);
            d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]; d[i + 3] = 255;
        }
    }
    BarCtx.putImageData(img, 0, 0);
    // Both ends come from the same 99th-percentile scale that drives the
    // surface colour, so the bar and the picture cannot disagree.
    el('cmap-hi').textContent = '+' + fe(scale);
    el('cmap-lo').textContent = '\u2212' + fe(scale);
    el('cmap-mid').textContent = '0';
}

function updateLegend(overlay) {
    const on = showErrors();
    const show = on && overlay;
    if (show) drawColorBar(overlay.scale);
    el('cmap-bar').className = show ? '' : 'hidden';
    // The bar says everything except what to do when there is nothing to show.
    el('cmap-legend').textContent = (on && !overlay) ? 'No fit yet.' : '';
}

// ================================================================== detail
// One knob instead of three. It sets how much surface the fit is allowed to
// spend, which is simultaneously how closely the result follows the input and
// how long the emitted OpenSCAD is -- those are the same quantity, so they
// should not be three separate numeric fields.
//
// The rectangular fit emits one line per patch on top of a fixed ~18-line
// preamble, so "lines of code" is a real, predictable readout, not a guess.

const DETAIL = [
    { nx: 4,  degree: 3 },
    { nx: 5,  degree: 4 },
    { nx: 6,  degree: 5 },
    { nx: 8,  degree: 6 },
    { nx: 10, degree: 8 },
    { nx: 12, degree: 10 },
    { nx: 16, degree: 12 },
    { nx: 20, degree: 14 },
];

function detailLevel() {
    return Math.max(1, Math.min(DETAIL.length, Math.round(num('detail', 5))));
}

// The knob IS the control-point count. It used to write into three number
// fields in the diagnostics pane, which were then read back; they are gone, so
// it reads straight off the table.
function detailParams() { return DETAIL[detailLevel() - 1]; }

function updateDetailInfo() {
    const lvl = detailLevel();
    const src = el('scad-out').value;
    const n = (src.match(/^  \[\[\[/gm) || []).length;
    el('detail-info').textContent = src
        ? `Level ${lvl} of ${DETAIL.length} \u2014 ${n} patch${n === 1 ? '' : 'es'}, ` +
          `${src.split('\n').length} lines`
        : `Level ${lvl} of ${DETAIL.length}`;
}

el('detail').addEventListener('input', () => { updateDetailInfo(); scheduleRun('fit'); });

// ============================================================ output scale

// Auto-fill only while the fields are still the app's. Once the user has typed
// in one, orbiting the preview must not overwrite what they typed.
function refreshExportSizes() {
    if (!Input) return;
    if (sizeTouched) {
        el('size-src').textContent = 'Your sizes. Load the file again to restore the STL\u2019s.';
        return;
    }
    el('size-x').value = String(+Input.sizeX.toFixed(4));
    el('size-y').value = String(+Input.sizeY.toFixed(4));
    el('size-height').value = String(+Input.height.toFixed(4));
    el('size-src').textContent = Input.scaleNote;
}

function outputSize() {
    return {
        sizeX: num('size-x', 100),
        sizeY: num('size-y', 100),
        height: num('size-height', 20),
    };
}

function emitScad() {
    if (!Input) return;
    const o = outputSize();
    const common = { W: Input.W, H: Input.H, contour: Input.contour };
    // One user-facing output. Normally the outline patch; the rectangular fit
    // only when the outline could not be followed at all.
    const useWarp = !!(LastWarp && !usingFallback);

    // Emitting is not free -- the slope figure on the thickness line walks the
    // whole patch grid -- so build only the stage that is going to be read.
    // Both, when the debug view is open and shows both.
    if (LastFit && (DEBUG || !useWarp)) {
        el('scad-fit').value = REPORT.patchesToScad(LastFit.patches, Object.assign({}, common, o));
    } else if (!DEBUG) {
        el('scad-fit').value = '';
    }
    if (LastWarp && (DEBUG || useWarp)) {
        el('scad-warp').value = REPORT.patchesToScad([LastWarp.w.patch],
            Object.assign({ warped: true }, common, o));
    } else if (!DEBUG) {
        el('scad-warp').value = '';
    }
    el('scad-out').value = useWarp ? el('scad-warp').value : el('scad-fit').value;
    updateDetailInfo();
}

// ============================================================ copy/download

el('copy-scad').addEventListener('click', copyScad);
el('download-scad').addEventListener('click', downloadScad);

let copyTimer = null;
function copyNote(msg, bad) {
    const n = el('copy-note');
    n.textContent = msg;
    n.className = bad ? 'err' : '';
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { n.textContent = ''; }, 2500);
}

function copyScad() {
    const text = el('scad-out').value;
    if (!text) return copyNote('Nothing to copy yet.', true);
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    if (nav && nav.clipboard && nav.clipboard.writeText) {
        nav.clipboard.writeText(text).then(() => copyNote('Copied'), () => legacyCopy(text));
    } else {
        legacyCopy(text);
    }
}

// Older browsers, and any page not served over https, have no clipboard API.
// Select the textarea instead so the code is one keystroke away.
function legacyCopy(text) {
    const ta = el('scad-out');
    let ok = false;
    try {
        if (ta.select) ta.select();
        if (typeof document !== 'undefined' && document.execCommand) {
            ok = document.execCommand('copy');
        }
    } catch (e) { ok = false; }
    copyNote(ok ? 'Copied' : 'Press Cmd/Ctrl+C to copy \u2014 the code is selected.', !ok);
}

function scadFileName() {
    return String(FileName).replace(/\.stl$/i, '').replace(/[^\w.-]+/g, '_') + '.scad';
}

function downloadScad() {
    const text = el('scad-out').value;
    if (!text) return copyNote('Nothing to download yet.', true);
    if (typeof document === 'undefined' || !document.createElement ||
        typeof Blob === 'undefined' || typeof URL === 'undefined') return;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = scadFileName();
    if (a.click) a.click();
    if (URL.revokeObjectURL) setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ============================================================== stage 1 fit

function fitOptions() {
    // A cubic B-spline net needs at least 4 control points per axis; the
    // Detail table never goes below that, and the clamp keeps it honest.
    const n = Math.max(4, detailParams().nx);
    return { basis: FIT_BASIS, nx: n, ny: n, lambda: FIT_LAMBDA };
}

function runFit() {
    if (!Input) ensureInput();
    const { W, H, z, mask, contour } = Input;
    const o = fitOptions();

    const weight = CONTOUR.buildWeights(mask, W, H, {
        band: EDGE_BAND,
        edgeWeight: EDGE_WEIGHT,
    });

    const t0 = performance.now();
    const fit = FIT.fitHeightField(z, W, H, {
        basis: o.basis, nx: o.nx, ny: o.ny, mask, weight, lambda: o.lambda,
    });
    const tFit = performance.now() - t0;

    const grid = FIT.evalGrid(fit, W, H);
    const st = REPORT.stats(z, grid, mask, W, H, uScale());
    const lift = REPORT.liftContour(fit, contour, z, W, H, uScale());
    const patches = FIT.toBezierPatches(fit);

    LastFit = { fit, grid, st, lift, patches };
    state.fit = 'ok';

    drawSurface(grid);
    emitScad();
    // A new fit is a new error field. This used to happen as a side effect of
    // drawing the (now deleted) Advanced error canvas; without it the cache
    // survived a refit and the surface was coloured -- and the bar labelled --
    // from the previous one.
    ErrField = null;

    const dof = fit.Nx * fit.Ny;
    if (DEBUG) el('report-fit').textContent = [
        `basis          ${o.basis}   control net ${fit.Nx} x ${fit.Ny}   (${dof} height DOF)`,
        `input          ${W} x ${H} px      mask: ${Input.maskInfo.rule}, ${fit.nUsed} px fitted`,
        `solve          ${tFit.toFixed(1)} ms   (closed form, no iteration)`,
        `bezier output  ${patches.length} patch${patches.length === 1 ? '' : 'es'}`,
        '',
        'FIT ERROR inside mask',
        `  rms ${fe(st.rms)}    mae ${fe(st.mae)}    p95 ${fe(st.p95)}` +
        `    max ${fe(st.max)}    bias ${st.bias >= 0 ? '+' : ''}${fe(st.bias)}`,
        `  rms is ${(100 * st.rms / uScale()).toFixed(2)}% of full relief;` +
            `  ${(st.n / dof).toFixed(0)} pixels per DOF`,
        '',
        'CONTOUR LIFT  (stage 2 boundary reliability)',
        contour.length
            ? `  ${contour.length} outline pts    rms ${fe(lift.rms)}    max ${fe(lift.max)}`
            : '  no outline traced',
        contour.length && lift.rms > 2 * st.rms
            ? '  ! boundary error exceeds 2x the interior rms'
            : '  boundary error is in line with the interior fit',
        '',
        'EXTRAPOLATION outside the mask (z is 0..1 inside)',
        st.extrapMin === null
            ? '  none - the mask covers the whole rectangle'
            : `  z range [${st.extrapMin.toFixed(2)}, ${st.extrapMax.toFixed(2)}]` +
              (Math.max(-st.extrapMin, st.extrapMax - 1) > 1
                  ? '   ! wild - do not trim against this'
                  : '   tame - safe to trim against the outline'),
    ].join('\n');
}

// ============================================================= stage 2 warp

function runWarp() {
    if (!LastFit) throw new Error('no fitted surface yet');
    const { W, H, z, mask, contour } = Input;

    const t0 = performance.now();
    const w = WARP.warpFit(LastFit.fit, contour, W, H, {
        degree: detailParams().degree,
        domain: WARP_DOMAIN,
        searchCorners: WARP_SEARCH_CORNERS,
        hoschek: WARP_HOSCHEK,
        lambda: WARP_LAMBDA,
        zScale: uScale(),
        mask,
    });
    const tWarp = performance.now() - t0;

    // A fold is the one thing that can make the emitted solid unusable. The
    // output is a shell: the surface, and a copy of it offset straight down.
    // Two graphs of z = f(x,y) a constant apart cannot meet -- but only where
    // the surface IS a graph. Where the (u,v) -> (x,y) map reverses, the sheet
    // lies over itself and the offset copy cuts through it. The result is
    // still edge-manifold, so nothing downstream notices; it is simply a bad
    // surface.
    //
    // WHERE it reverses decides whether that matters, and the threshold is
    // measured rather than guessed. REPORT.surfaceStats counts reversals more
    // than DEEP_BAND (15%) inside the parameter square; the constant's comment
    // in report.js carries the table. In short: no deep reversals means every
    // fold sits in a thin ring at the rim and costs at most about a percent of
    // the footprint, while one or more means the surface crosses itself
    // through the middle and the figure jumps to 9-13%. Nothing measured lands
    // between.
    //
    // This replaced a stricter rule -- warp.js's own foldWhere.interior, which
    // uses a 6% band. At 6% a peanut (19 interior reversals, 0.54% of its
    // footprint) and a clover (31, 1.15%) are refused, while a crescent (182,
    // 9.42%) and a C ring (219, 13.29%) are refused for a reason twenty times
    // larger. A rule that cannot tell those apart refuses smooth blobs, which
    // are the shapes this tool is for.
    //
    // Thrown, not warned about: this reuses the silent fallback in runFrom().
    // A runtime "this might not be printable" is a message the user can
    // neither check nor act on. Scale-free, so the fold test does not depend
    // on the size boxes -- the sign of a Jacobian determinant is unchanged by
    // a positive scale on each axis.
    const fold = REPORT.surfaceStats([w.patch], 1, 1, 1);
    if (fold.deepFolded > 0) {
        throw new Error('the outline patch folds back over itself (' +
            fold.deepFolded + ' reversals of ' + fold.samples +
            ' samples, well inside the patch)');
    }

    // Compare against the ORIGINAL height field, not against f -- that is the
    // number that answers "how good is the final patch".
    const ras = WARP.rasterizePatch(w.patch, W, H);
    let sq = 0, n = 0, covIn = 0, maskN = 0;
    for (let i = 0; i < W * H; i++) {
        if (mask[i]) maskN++;
        if (ras.cov[i] && mask[i]) {
            covIn++;
            const e = (ras.z[i] - z[i]) * uScale();
            sq += e * e; n++;
        }
    }
    const e2e = n ? Math.sqrt(sq / n) : NaN;

    LastWarp = { w, ras, e2e };
    ErrField = null;              // a new surface is a new error field
    state.warp = 'ok';

    // The outline patch has no seams -- one patch -- so its grid is drawn at
    // the spacing of its own control net, which is what the Detail slider sets.
    setResult({ kind: 'warp', patch: w.patch, cells: w.degree });
    drawDomain(w);
    emitScad();

    // A wildly oscillating control net still fits the surface, but is useless
    // to inspect in OpenSCAD -- worth surfacing rather than hiding.
    let maxCp = 0, cpOut = 0;
    for (const row of w.patch) {
        for (const q of row) {
            maxCp = Math.max(maxCp, Math.abs(q[2]));
            if (q[0] < -0.25 || q[0] > 1.25 || q[1] < -0.25 || q[1] > 1.25 ||
                q[2] < -0.25 || q[2] > 1.25) cpOut++;
        }
    }

    const it = w.interior;
    const fw = it.foldWhere || { corner: 0, edge: 0, interior: 0 };
    const pct = (a, b) => (100 * a / Math.max(1, b)).toFixed(1) + '%';

    if (DEBUG) el('report-warp').textContent = [
        `degree         ${w.degree} x ${w.degree}   ${(w.degree + 1) ** 2} control points` +
            (w.degreeClamped ? '   (clamped: not enough outline samples)' : ''),
        `domain map     ${WARP_DOMAIN}` +
            (w.harmonic ? `   relaxed on a ${w.harmonic.grid}^2 grid` : ''),
        `corners        ${JSON.stringify(w.corners)}  of ${contour.length} outline pts` +
            (w.cornerSearch.searched ? '  (searched)' : '  (equally spaced)'),
        `elapsed        ${tWarp.toFixed(0)} ms`,
        `control net    max |z| ${maxCp.toFixed(2)} (surface lives in 0..1);` +
            ` ${cpOut} of ${(w.degree + 1) ** 2} points outside the geometry`,
        '',
        'BOUNDARY  (how well the 4 curves follow the traced outline)',
        `  xy  ${w.boundary.xyPx.map((v) => v.toFixed(2)).join(' / ')} px per side` +
            `   worst ${w.boundary.xyPxMax.toFixed(2)} px`,
        `  z   ${w.boundary.zGrey.map((v) => fe(v)).join(' / ')} per side` +
            `   worst ${fe(w.boundary.zGreyMax)}`,
        '',
        'DOMAIN MAP  (det J reversals = the surface folds over itself)',
        `  det J ranges ${it.detMin.toFixed(3)} .. ${it.detMax.toFixed(3)}` +
            `   orientation ${it.orientation > 0 ? '+' : '-'}`,
        `  ${it.folded} of ${it.samples} samples reversed (${pct(it.folded, it.samples)})` +
            `  -- ${fw.corner} at corners, ${fw.edge} on edges, ${fw.interior} strictly interior`,
        fw.interior === 0
            ? '  no interior reversals: the patch does not self-intersect'
            : '  ! interior reversals present - lower the degree, or the outline is too concave',
        w.harmonic
            ? `  relaxed map itself: ${(100 * w.harmonic.fold.foldFraction).toFixed(1)}% reversed,` +
              ' before the Bezier net approximates it'
            : '',
        '',
        'INTERIOR HEIGHTS  (warped patch vs the stage-1 surface f)',
        `  area-weighted rms ${fe(it.rms)}` +
            `    parameter-space rms ${it.rmsUnweighted.toFixed(3)}`,
        `  ${it.outside} of ${it.samples} samples landed outside the mask (down-weighted)`,
        '',
        'END TO END  (warped patch vs the original height field)',
        `  rms ${fe(e2e)} over ${covIn} px    coverage ${pct(covIn, maskN)} of the mask`,
        `  stage 1 alone was ${fe(LastFit.st.rms)};` +
            ` the warp costs ${(e2e - LastFit.st.rms >= 0 ? '+' : '')}${fe(e2e - LastFit.st.rms)}`,
    ].join('\n');
}

// ============================================================== diagnostics

function drawSurface(grid) {
    const { W, H } = Input;
    setSize(ResultCtx, W, H);
    const img = ResultCtx.createImageData(W, H);
    const d = img.data;
    for (let i = 0; i < W * H; i++) {
        const t = Math.round(Math.max(0, Math.min(1, grid[i])) * 255);
        d[4 * i] = d[4 * i + 1] = d[4 * i + 2] = t;
        d[4 * i + 3] = 255;
    }
    ResultCtx.putImageData(img, 0, 0);
}

// The parameter grid drawn in image space: folds show up directly as cells
// crossing over their neighbours.
function drawDomain(w) {
    const { W, H, mask } = Input;
    setSize(DomainCtx, W, H);

    const img = DomainCtx.createImageData(W, H);
    const d = img.data;
    for (let i = 0; i < W * H; i++) {
        const v = mask[i] ? 225 : 40;
        d[4 * i] = d[4 * i + 1] = d[4 * i + 2] = v;
        d[4 * i + 3] = 255;
    }
    DomainCtx.putImageData(img, 0, 0);

    const L = 13, S = 60;
    DomainCtx.lineWidth = 0.5;
    DomainCtx.strokeStyle = 'rgba(30,90,200,0.75)';
    const line = (fn) => {
        DomainCtx.beginPath();
        for (let k = 0; k <= S; k++) {
            const p = fn(k / S);
            const x = p[0] * (W - 1), y = p[1] * (H - 1);
            if (k === 0) DomainCtx.moveTo(x, y); else DomainCtx.lineTo(x, y);
        }
        DomainCtx.stroke();
    };
    for (let a = 0; a <= L; a++) {
        const t = a / L;
        line((s) => WARP.patchAt(w.patch, s, t));
        line((s) => WARP.patchAt(w.patch, t, s));
    }

    DomainCtx.strokeStyle = 'rgba(200,30,30,0.95)';
    DomainCtx.lineWidth = 1.5;
    line((s) => WARP.patchAt(w.patch, s, 0));
    line((s) => WARP.patchAt(w.patch, s, 1));
    line((s) => WARP.patchAt(w.patch, 0, s));
    line((s) => WARP.patchAt(w.patch, 1, s));

    DomainCtx.fillStyle = 'rgb(20,160,60)';
    for (const [cu, cv] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
        const p = WARP.patchAt(w.patch, cu, cv);
        DomainCtx.beginPath();
        DomainCtx.arc(p[0] * (W - 1), p[1] * (H - 1), 2.5, 0, 6.283);
        DomainCtx.fill();
    }
}

applyDebug();
updateDetailInfo();
updateWaterInfo();
updateLegend(null);
setStatus();

// A test seam, not a feature: the DOM-stub suite has to be able to assert that
// a left drag left the CAMERA alone, and that the capture axis really is the
// water normal in the object's frame. Neither is visible from the outside.
if (typeof window !== 'undefined') {
    window.BEZIVER_STATE = () => ({
        ObjM: ObjM.slice(), WaterM: WaterM.slice(),
        CamM: CamM.slice(), CapM: CapM.slice(),
        // Anything a left drag must not move: the cut-off height, the plane's
        // drawn size and screen placement, and the view scale.
        waterLevel: Mesh ? waterLevel() : 0,
        // The slider's fixed per-file range, and the model's extent along the
        // water normal: the two things the readout's percentage is derived
        // from. The second one DOES move with the object, on purpose.
        meshRadius: Mesh ? meshRadius() : 0,
        shadeRange: Mesh ? shadeRange() : null,
        errorScale: (Input && LastFit) ? errorField().scale : null,
        zRange: Mesh ? [captureExtent().lo[2], captureExtent().hi[2]] : null,
        planeRadius: Mesh ? PLANE_EDGE * meshRadius() : 0,
        // Per unit of raster, so it is comparable across resolutions and still
        // catches any orientation dependence in the framing.
        viewScale: Mesh ? projector(1).k : 0,
        zoom: Zoom,
        plane: LastPlane && Object.assign({}, LastPlane),
        // World-space geometry of the water grid: spacing, height, and the two
        // ends of one line. A drag of either canvas must leave all of it alone.
        waterGrid: Mesh ? (() => {
            const g = waterGridSpec();
            return { spacing: g.spacing, level: g.level, n: g.n,
                     a: g.world(g.spacing, -g.outer), b: g.world(g.spacing, g.outer) };
        })() : null,
    });
}

if (typeof window !== 'undefined') window.BEZIVER_READY = BUILD;

} catch (err) {
    if (typeof window !== 'undefined' && window.__beziverBootError) {
        window.__beziverBootError('This page could not start: ' + err.message +
                                  '. Reload with Shift held.');
    }
    throw err;
}
})();
