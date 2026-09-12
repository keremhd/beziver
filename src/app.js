const FIT = require('./fit.js');
const CONTOUR = require('./contour.js');
const REPORT = require('./report.js');
const WARP = require('./warp.js');
const STL = require('./stl.js');
const SAMPLE = require('./sample.js');

// Bumped whenever index.html and this file must ship together; the page
// checks it so a stale bundle announces itself instead of silently doing
// nothing. Keep in sync with window.BEZIVER_BUILD in index.html.
const BUILD = 26;

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
        ' \u2014 page and script out of sync');
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

// THREE rotations, each with exactly one owner. They must stay uncoupled: a
// camera that counter-rotates with the model reads as the water sloshing.
//
//   ObjM    the model in the world. The LEFT drag turns this and nothing else.
//   WaterM  the cut-off plane in the world. Identity, always: the slider sets
//           its height, not its angle. Named because the capture axis derives
//           from it.
//   CamM    the camera. The RIGHT drag turns this and nothing else. Shared by
//           both panes.
//
// The capture axis is DERIVED, never dragged: CapM = WaterM * ObjM, capture
// space being the water frame seen from the object. Its third row is the water
// normal in object coordinates, the axis depthRender projects along. Tip the
// object and the axis follows; move the camera and the pipeline is untouched.
//
// 3x3 matrices, not yaw/pitch/roll. The drags compose rotations (installOrbit),
// and Euler angles do not compose by adding components: that cancels cleanly
// for a horizontal drag and visibly fails for a diagonal one. depthRender takes
// transformed vertices, so nothing downstream wants angles.
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

// Resolution of the previews. Not autoResolution(): that sizes the pipeline's
// raster, this one is redrawn on every mouse-move. The backing store matches
// the displayed size times devicePixelRatio, so nothing is upscaled.
//
// Cost is per fragment and this runs per drag frame, so raising the constant
// makes dragging crawl: 256 -> 1000 px is 15x the fill work. Progressive
// refinement instead: reduced scale during a drag, full resolution once it
// settles.
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
// These were all controls once. None is a decision a user can meaningfully
// make, so the app makes it. Still passed through the option objects
// fit.js / warp.js already accept.

// Cubic B-spline, always. The alternative (single-patch Bernstein) is worse at
// every detail level above 1 and the only way to want it is to already know
// what C2 continuity is.
const FIT_BASIS = 'bspline';

// Contour pixels are weighted up so the fit does not drift at the outline,
// where stage 2 hands it to the boundary curves. 3 px band, 3x weight.
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
//
// It does not run at all while a drag is in progress. A run is far and away
// the longest thing this page does -- the warp alone is ~100 ms on a laptop
// and several times that on a phone -- and a browser stops a script that
// holds the thread that long, repeatedly. The debounce alone did not prevent
// that: a busy thread delivers pointermove in bursts, the gaps between them
// outlast the debounce, and the run fires mid-drag, which makes the thread
// busier still. Nothing is lost by waiting, either. The fit answers a
// question about an orientation that is still being chosen, and the surface
// already follows the live capture frame while it is chosen.
function scheduleRun(from) {
    markStale(from);
    if (runTimer) clearTimeout(runTimer);
    runTimer = setTimeout(guard('starting a run', () => {
        runTimer = null;
        if (Dragging) return scheduleRun(from);
        runFrom(from);
    }), 280);
}

function* runSteps(from) {
        const i = STAGES.indexOf(from);
        if (i <= 0) { doing('reading the model'); yield* ensureInputSteps(); }
        if (i <= 1) { doing('fitting the surface'); yield* runFitSteps(); }
        if (i <= 2 && LastFit) {
            // The warp is the product. When it cannot be built the rectangular
            // fit is still a usable answer, so take it automatically -- this is
            // a fallback, never a question put to the user.
            try {
                doing('fitting the outline patch');
                yield* runWarpSteps();
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
}

// A request arriving mid-run is remembered rather than dropped: now that a run
// spans frames, dropping it would leave the output stale for good.
let PipelineJob = null, pendingFrom = null;
let SlicedMs = 0;              // main-thread time actually spent stepping

function runFrom(from) {
    if (running) {
        const i = STAGES.indexOf(from);
        if (pendingFrom === null || i < STAGES.indexOf(pendingFrom)) pendingFrom = from;
        return;
    }
    running = true;
    errored = false;
    clearErrors();
    PipelineJob = runSteps(from);
    if (typeof requestAnimationFrame !== 'function') return stepPipeline(Infinity);
    setStatus();
    scheduleFrame();
}

// A stage that asks for a redraw re-enters the frame loop, which would land
// back here and step the generator it is already inside.
let stepping = false;

function stepPipeline(deadline) {
    if (!PipelineJob || stepping) return;
    stepping = true;
    const start = clock();
    try {
        // Stages differ by orders of magnitude in length, so the clock is read
        // at every yield rather than every so many; the stages that yield
        // often enough for that to cost anything batch it themselves.
        for (;;) {
            if (PipelineJob.next().done) {
                PipelineJob = null;
                break;
            }
            if (clock() >= deadline) break;
        }
    } catch (e) {
        PipelineJob = null;
        fail(e);
    } finally {
        stepping = false;
    }
    SlicedMs += clock() - start;
    if (PipelineJob) return;
    running = false;
    setStatus();
    if (pendingFrom !== null) {
        const next = pendingFrom;
        pendingFrom = null;
        runFrom(next);
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
        n.textContent = 'Outline failed \u2014 fitted a rectangle instead.';
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
        : 'fallback: rectangular fit';
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

function* ensureInputSteps() {
    if (!Mesh) throw new Error('load an STL first');
    yield* captureDepthSteps();   // also commits the depth map as the height field
    state.input = 'ok';
    refreshExportSizes();
}

// The cut-off slider's path: the orientation has not moved, so the cached
// depth render is reused and there is nothing long enough here to slice.
function captureDepth() {
    const g = captureDepthSteps();
    let r = g.next();
    while (!r.done) r = g.next();
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
    Depth = null;
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
    requestRedraw('both');
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
    requestRedraw('both');
}

blockDrag(el('water-track'));
// The value reads on demand: it appears beside the grip while the slider is in
// use and fades when it is not. A slider with no readable value is a
// regression; a permanent line of text is clutter. The pointer lands on the
// track and the focus on the input, so each watches for its own.
el('water-track').addEventListener('mouseenter', () => flashWaterInfo());
el('stl-water').addEventListener('focus', () => flashWaterInfo());

// Where a value sits along its track, as a CSS length. The pad at each end is
// the grip's own travel, so the extremes land on the ends rather than half a
// grip past them; grip and readout both hang on their centres, so this is the
// position of the value itself.
const SLIDER_PAD = 7;
function sliderOffset(f) {
    return 'calc(' + SLIDER_PAD + 'px + (100% - ' + (2 * SLIDER_PAD) + 'px) * ' +
           Math.max(0, Math.min(1, f)) + ')';
}

// Each installed slider leaves its painter here, so the value changing by any
// route -- drag, arrow key, reset, load -- can put the grip where it belongs.
const SliderPaint = {};
function paintSlider(id) { if (SliderPaint[id]) SliderPaint[id](); }

let waterInfoTimer = null;
function flashWaterInfo() {
    const n = el('water-info');
    updateWaterInfo();
    n.className = 'show';
    if (n.style) n.style.bottom = sliderOffset(num('stl-water', 0) / 1000);
    if (waterInfoTimer) clearTimeout(waterInfoTimer);
    waterInfoTimer = setTimeout(() => { n.className = ''; }, 1600);
}

function onWaterInput() {
    flashWaterInfo();
    if (!Mesh) return;
    try { captureDepth(); refreshExportSizes(); } catch (e) { return fail(e); }
    scheduleRun('fit');   // the height field is already rebuilt
}

el('stl-water').addEventListener('input', onWaterInput);

// Both sliders are driven from pointer events on a track of our own, with the
// range input kept as the keyboard target and the accessible control. The
// input takes no pointer at all: a native range moves its own value on the
// click a touch leaves behind, which is a value nobody asked for, and it is
// not laid out dependably enough along a vertical axis to follow a finger. The
// pointer capture keeps the value with a finger that has left the track.
function installSlider(id, opts) {
    const input = el(id), track = el(opts.track), grip = el(opts.grip);
    const { min, max, step, vertical, onChange } = opts;

    const paint = () => {
        if (!grip.style) return;
        const at = sliderOffset((num(id, min) - min) / (max - min || 1));
        if (vertical) grip.style.bottom = at; else grip.style.left = at;
    };
    SliderPaint[id] = paint;
    paint();

    if (!track.addEventListener || !track.getBoundingClientRect) return;
    let id_ = null;

    const setFrom = (e) => {
        const r = track.getBoundingClientRect();
        const span = Math.max(1, (vertical ? r.height : r.width) - 2 * SLIDER_PAD);
        // Up is more on a vertical track, right is more on a horizontal one.
        const f = vertical ? 1 - (e.clientY - r.top - SLIDER_PAD) / span
                           : (e.clientX - r.left - SLIDER_PAD) / span;
        const raw = min + Math.max(0, Math.min(1, f)) * (max - min);
        const v = String(min + Math.round((raw - min) / step) * step);
        if (v === input.value) return;
        input.value = v;
        paint();
        onChange();
    };

    track.addEventListener('pointerdown', guard('grabbing a slider', (e) => {
        id_ = e.pointerId;
        if (track.setPointerCapture) {
            try { track.setPointerCapture(id_); } catch (_) { /* gone already */ }
        }
        if (e.preventDefault) e.preventDefault();
        if (input.focus) input.focus();   // the drag is ours; the keyboard is the input's
        if (opts.drag) Dragging = true;
        setFrom(e);
    }));
    track.addEventListener('pointermove', guard('moving a slider', (e) => {
        if (e.pointerId !== id_) return;
        if (e.preventDefault) e.preventDefault();
        setFrom(e);
    }));
    const drop = (e) => {
        if (e.pointerId !== id_) return;
        id_ = null;
        if (track.releasePointerCapture) {
            try { track.releasePointerCapture(e.pointerId); } catch (_) { /* gone already */ }
        }
        if (!Dragging) return;
        Dragging = false;
        redrawPreviews();      // the settled frame, at full resolution
    };
    track.addEventListener('pointerup', guard('releasing a slider', drop));
    track.addEventListener('pointercancel', guard('releasing a slider', drop));
}

installSlider('stl-water', {
    track: 'water-track', grip: 'water-grip',
    min: 0, max: 1000, step: 1, vertical: true, drag: true,
    onChange: () => { onWaterInput(); flashWaterInfo(); },
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
    paintSlider('stl-water');
    if (!Mesh) { n.textContent = 'Whole model'; return; }
    const ext = captureExtent();
    const kept = ext.hi[2] - Math.max(waterLevel(), ext.lo[2]);
    const total = Math.max(1e-12, ext.hi[2] - ext.lo[2]);
    const pct = Math.round(100 * Math.max(0, kept) / total);
    n.textContent = kept <= 0
        ? 'Nothing above the cut-off'
        : `Top ${kept.toFixed(2)} mm \u2014 ${pct}% of the model`;
}

// Depth render along the CAPTURE axis + water threshold + commit as the height
// field. There is no separate "use this" step: the depth map IS the input.
let DepthKey = '';
function* captureDepthSteps() {
    if (!Mesh) return;
    const n = autoResolution(Mesh.count);
    // The render depends on the capture orientation alone -- the cut-off is
    // applied to its output below -- so a cut-off drag reuses it and costs one
    // applyWater instead of rasterising every triangle (55 ms at 200k on a
    // laptop, several times that on a phone). loadMesh nulls Depth to drop it.
    const key = n + ':' + CapM.join(',');
    if (!Depth || DepthKey !== key) {
        const rot = STL.transformVerts(Mesh.verts, CapM, Mesh.bounds.center);
        Depth = yield* STL.depthRenderSteps(rot, n, n, {});
        DepthKey = key;
    }

    // applyWater takes a fraction of the depth render's own z range; the
    // slider is an absolute height, so convert here rather than let a fraction
    // back into the model. Out-of-range clamps: below the mesh keeps all of it,
    // above the mesh leaves nothing and raises the inline error below.
    const zSpan = Math.max(1e-12, Depth.zmax - Depth.zmin);
    const water = STL.applyWater(Depth, (waterLevel() - Depth.zmin) / zSpan);
    Depth.water = water;
    ErrField = null;
    updateWaterInfo();     // the mm figure needs the render's z range
    requestRedraw();

    el('stl-info').textContent =
        `${FileName} \u2014 ${Mesh.count.toLocaleString()} triangles`;

    if (water.above < 64) {
        throw where('water', new Error(
            'Too little above the cut-off. Lower it.'));
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
        scaleNote: 'From the STL. Edit to resize.',
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

// One camera for both panes, at one fixed scale, so neither orbiting nor
// tipping ever resizes anything and the fitted surface comes out the size of
// the model it was fitted to.
//
// Zoom is a property of that shared camera, like its orientation: one value
// applied to both panes, and a gesture on either canvas moves both. Per-pane
// zoom would break the point of it, which is that the two panes read as one
// scene seen from one place.
//
// It multiplies the projector's scale and nothing else. `rad` stays the world
// radius: the one thing derived from it that is not a screen size is
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

// Both previews rasterise every triangle in software, slower than a drag
// delivers pointermove. A request marks what is out of date; the frames below
// draw it a slice at a time.
const Pending = { preview: false, result: false, frame: false };
// Named for what it is rather than `now`: the pinch handler already has a
// local `now`, and one shadowing the other reads as a mistake.
const clock = () => (typeof performance !== 'undefined' && performance.now
    ? performance.now() : Date.now());

// The longest a touch can wait to be answered.
const SLICE_MS = 8;
let ResultJob = null, LastPane = 'result';   // so the dragged pane goes first

// What the page is in the middle of, so a fault can say where it happened.
// Read by the handler in index.html.
function doing(what) {
    if (typeof window !== 'undefined') window.BEZIVER_DOING = what;
}
// A throw in a frame callback or a pointer handler reaches nobody but the
// browser, which strips it to a bare "Script error." Caught here it keeps its
// message.
function guard(label, fn) {
    return function (a) {
        try { return fn.call(this, a); } catch (e) { crashed(label, e); }
    };
}

function crashed(label, e) {
    console.error(label, e);
    if (typeof window === 'undefined' || !window.__beziverBootError) return;
    window.__beziverBootError('Something went wrong while ' + label + ': ' +
        ((e && e.message) || String(e)) + '.', true);
}

let PreviewJob = null;

// 'preview' (the default) is the left pane, 'result' the right, 'both' the
// pair.
function requestRedraw(what) {
    if (what !== 'result') Pending.preview = true;
    if (what === 'both' || what === 'result') Pending.result = true;
    // No rAF (the tests' DOM stub): nothing to spread the work across.
    if (typeof requestAnimationFrame !== 'function') return flushRedraw(Infinity);
    scheduleFrame();
}

function scheduleFrame() {
    if (Pending.frame || typeof requestAnimationFrame !== 'function') return;
    Pending.frame = true;
    requestAnimationFrame(guard('drawing a frame', () => flushRedraw()));
}

function flushRedraw(deadline) {
    Pending.frame = false;
    const until = deadline === undefined ? clock() + SLICE_MS : deadline;
    try {
        // One pane at a time, and they take turns. The frame in flight
        // finishes first: restarting on each request would abandon a mesh too
        // big for one slice every time the finger moved, and nothing would
        // reach the canvas until the drag ended. Turns matter for the same
        // reason -- a drag re-requests BOTH panes on every pointermove, so
        // always preferring the same one starves the other for the whole
        // gesture. The camera is shared, so that other one is visibly wrong,
        // not merely stale.
        for (;;) {
            if (!PreviewJob && !ResultJob) {
                const takeResult = Pending.result &&
                                   (!Pending.preview || LastPane === 'preview');
                if (takeResult) {
                    Pending.result = false;
                    LastPane = 'result';
                    ResultJob = startResult();
                } else if (Pending.preview) {
                    Pending.preview = false;
                    LastPane = 'preview';
                    PreviewJob = startPreview();
                }
            }
            if (PreviewJob) {
                doing('drawing the model');
                if (PreviewJob.step(until)) {
                    PreviewJob.finish();
                    PreviewJob = null;
                }
            } else if (ResultJob) {
                doing('drawing the surface');
                if (ResultJob.step(until)) {
                    ResultJob.finish();
                    ResultJob = null;
                }
            } else {
                break;          // nothing in flight and nothing asked for
            }
            if (clock() >= until) break;
        }
    } catch (e) {
        PreviewJob = ResultJob = null;
        Pending.preview = Pending.result = false;
        fail(e);
    }
    // Whatever is left of the slice. One budget for both is what stops them
    // adding up to a long frame.
    stepPipeline(until);
    if (PreviewJob || ResultJob || Pending.preview || Pending.result || PipelineJob) {
        return scheduleFrame();
    }
    doing('');
}

// The canvas holds the last finished frame until a new one is complete, so a
// half-drawn mesh is never shown.
function startPreview() {
    if (!Mesh) return null;
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

    let t = 0;
    return {
        // Reading the clock per triangle would cost more than a triangle.
        step(deadline) {
            let batch = 0;
            for (; t < V.length; t += 9) {
                if (++batch >= 512) { batch = 0; if (clock() >= deadline) return false; }
                for (let j = 0; j < 3; j++) {
                    const x = V[t + j * 3] - cx, y = V[t + j * 3 + 1] - cy,
                          z = V[t + j * 3 + 2] - cz;
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
            return true;
        },
        // The cut plane goes on last, over a finished mesh.
        finish() {
            drawCutPlane(R, P, Mc, Mk, level);
            flushRaster(StlCtx, R);
        },
    };
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

// A flat translucent disc seen edge-on has no texture, so no parallax, so no
// sense of which way it is lying. Converging grid lines read as a receding
// plane from any camera angle.
//
// Thin, solid, neutral grey: the ground-plane grid of every CAD tool, so it is
// recognised rather than read.
//
// It has to be told apart from the control grid on the fitted surface, often
// visible at the same time. Both are solid, separated by WEIGHT and CONTRAST,
// not style: the control grid is dark and firm on a light surface, this one a
// pale grey at a fifth alpha over a dark one. The loud one carries data.
//
// Depth-tested against the model, so the object occludes the lines behind it.
function drawWaterGrid(R, pt, inner, outer) {
    const g = waterGridSpec();
    const N = R.N;
    const rgb = GRID_RGB;
    // Two samples per pixel at this frame's resolution, zoom included, or the
    // lines break into dots.
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

// No capture-direction arrow on this pane. The plane the model stands in and
// the blue below it already say which way is up. If the direction ever needs
// stating, state it next to the slider, not as a glyph on the picture.

// ---------------------------------------------- right pane: the result
// The product, rendered as a solid from the same camera and sitting in the same
// place in space as the model it was fitted to -- so turning the view turns
// both, and the two panes are the same scene.

let ResultGeom = null;   // { kind: 'warp', patch } | { kind: 'grid', grid }, + cells

function setResult(geom) { ResultGeom = geom; requestRedraw('result'); }

// The Detail slider IS control-net density, and until now nothing on screen
// said so. These are the isoparametric lines of the control net drawn on the
// surface itself: for the rectangular fit they are the seams between adjacent
// Bezier patches; the outline patch is a single patch with no seams, so it gets
// an isoparametric grid at the same spacing as its control net instead, which
// keeps the slider from being a no-op there. Default on -- it is the feedback
// the slider was missing, not a diagnostic.
const showGrid = installToggle('show-grid', true, () => requestRedraw('result'));

// Sample counts across the surface. 56 is where a smooth patch stops showing
// facets at 256 px; the grid fallback samples the same way.
const RESULT_STEPS = 56;

// Headroom at each end of the height -> grey ramp: the fitted surface
// overshoots the 0..1 of the height field. Ramp only -- the geometry is drawn
// unclamped, since clamping z flattens the overshoot onto a plane.
const RESULT_HEADROOM = 0.05;

// At the top detail levels this is a few hundred thousand tessellated
// triangles with a per-fragment overlay.
function startResult() {
    if (!Mesh || !ResultGeom || !Depth || !Depth.water || !Input) return null;
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
        const czs = level + z01 * span;
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
    // Returns the height there, or NaN outside the mask, which only the
    // rectangular fit has. NaN and not a negative sentinel: the surface
    // overshoots below zero near the rim.
    const surfaceAt = (a, b) => {
        if (ResultGeom.kind === 'warp') {
            const q = WARP.patchAt(ResultGeom.patch, a, b);
            toCam(q[0], q[1], q[2]);
            errAt(q[0], q[1]);
            return q[2];
        }
        const px = Math.round(a * (W - 1)), py = Math.round(b * (H - 1));
        if (!Input.mask[py * W + px]) return NaN;
        const z01 = ResultGeom.grid[py * W + px];
        toCam(a, b, z01);
        errAt(a, b);
        return z01;
    };

    // A row between clock readings: fine enough at every detail level.
    const sampleRow = (j) => {
        for (let i = 0; i <= S; i++) {
            const idx = j * (S + 1) + i;
            const h = surfaceAt(i / S, j / S);
            if (!Number.isFinite(h)) continue;
            vx[idx] = OUT[0]; vy[idx] = OUT[1]; vz[idx] = OUT[2];
            vh[idx] = h; ve[idx] = ERR[0]; vc[idx] = ERR[1]; ok[idx] = 1;
        }
    };

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
        const h = l1 * hh[0] + l2 * hh[1] + l3 * hh[2];
        const u = Math.max(0, Math.min(1,
            (h + RESULT_HEADROOM) / (1 + 2 * RESULT_HEADROOM)));
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

    const drawRow = (j) => {
        for (let i = 0; i < S; i++) {
            const p = j * (S + 1) + i;
            tri(p, p + 1, p + S + 2);
            tri(p, p + S + 2, p + S + 1);
        }
    };

    let vj = 0, tj = 0;
    return {
        step(deadline) {
            while (vj <= S) {
                sampleRow(vj++);
                if (clock() >= deadline) return false;
            }
            while (tj < S) {
                drawRow(tj++);
                if (clock() >= deadline) return false;
            }
            return true;
        },
        // The grid goes over a finished surface.
        finish() {
            if (showGrid()) drawSurfaceGrid(R, P, surfaceAt, OUT);
            flushRaster(WarpCtx, R);
            updateLegend(overlay);
        },
    };
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
        if (!Number.isFinite(surfaceAt(a, b))) return;
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
    left.addEventListener('pointerdown', guard('starting a drag', grab('object')));
    right.addEventListener('pointerdown', guard('starting a drag', grab('camera')));
    const up = (e) => {
        if (e && id !== null && e.pointerId !== undefined && e.pointerId !== id) return;
        release();
    };
    window.addEventListener('pointerup', guard('ending a drag', up));
    // A touch drag that leaves the canvas, or that the browser takes over,
    // ends as a cancel and never as an up. Without this the pane stays stuck
    // in its low-resolution drag frame.
    window.addEventListener('pointercancel', guard('ending a drag', up));
    window.addEventListener('pointermove', guard('turning the model', (e) => {
        if (!target || !Mesh) return;
        if (id !== null && e.pointerId !== undefined && e.pointerId !== id) return;
        const dx = e.clientX - lx, dy = e.clientY - ly;
        lx = e.clientX; ly = e.clientY;
        dragBy(target, dx, dy);
    }));
}
installOrbit();

// ------------------------------------------------------------------ zoom
// Standard browser inputs only; no gesture recognition of our own beyond
// reading two pointers apart.
//
// On a Mac trackpad a two-finger slide arrives as a `wheel` event and a pinch
// as a `wheel` with ctrlKey set: the browser's own convention. Both mean zoom
// here, so a mouse wheel works with no extra case.
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
        c.addEventListener('wheel', guard('zooming', (e) => {
            if (!Mesh) return;
            if (e.preventDefault) e.preventDefault();
            // deltaMode 1 is lines, 2 is pages; only 0 is already pixels.
            const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
            const d = (e.deltaY || 0) * unit;
            // A pinch reports much smaller deltas than a wheel notch for the
            // same intent, so it gets the larger constant.
            by(Math.exp(-d * (e.ctrlKey ? 0.01 : 0.0025)));
        }), { passive: false });

        // Touch pinch: two live pointers, and the ratio of their separation.
        const live = new Map();
        let apart = 0;
        const spread = () => {
            const p = [...live.values()];
            return p.length === 2 ? Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) : 0;
        };
        c.addEventListener('pointerdown', guard('starting a pinch', (e) => {
            if (e.pointerType !== 'touch') return;
            live.set(e.pointerId, { x: e.clientX, y: e.clientY });
            apart = spread();
        }));
        c.addEventListener('pointermove', guard('pinching', (e) => {
            if (!live.has(e.pointerId)) return;
            live.set(e.pointerId, { x: e.clientX, y: e.clientY });
            const now = spread();
            if (!apart || !now) return;
            if (e.preventDefault) e.preventDefault();
            by(now / apart);
            apart = now;
        }));
        const drop = (e) => {
            if (!live.delete(e.pointerId)) return;
            apart = spread();
        };
        c.addEventListener('pointerup', guard('ending a pinch', drop));
        c.addEventListener('pointercancel', guard('ending a pinch', drop));
    }
}
installZoom();

// The settled frame is the largest single draw there is, and the least
// urgent.
function redrawPreviews() {
    if (!Mesh) return;
    requestRedraw('both');
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

    // The cut-off follows at once -- the preview reads the capture extent
    // straight off the mesh, so it does not wait for a depth render. The
    // pipeline waits for the usual debounce, and restarts from 'input' because
    // the orthographic axis has moved.
    requestRedraw('both');
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
    requestRedraw('result');
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
    el('cmap-legend').textContent = (on && !overlay) ? 'No fit' : '';
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

// The knob IS the control-point count, read straight off the table.
function detailParams() { return DETAIL[detailLevel() - 1]; }

// Report the control net, not the line count: the emitter puts a whole patch
// on one line and the warped output is always one patch, so line count is
// constant at every level. The net is not.
function updateDetailInfo() {
    const lvl = detailLevel();
    paintSlider('detail');
    const src = el('scad-out').value;
    const rows = src.match(/^  \[\[\[.*$/gm) || [];
    const n = rows.length;
    // Control points are the only `[` in a patch line followed by a number.
    const pts = n ? (rows[0].match(/\[-?[\d.]/g) || []).length : 0;
    const side = Math.round(Math.sqrt(pts));
    el('detail-info').textContent = src
        ? `Level ${lvl}/${DETAIL.length} \u2014 ${n} patch${n === 1 ? '' : 'es'}, ` +
          `${side}\u00d7${side} control points`
        : `Level ${lvl}/${DETAIL.length}`;
}

function onDetailInput() { updateDetailInfo(); scheduleRun('fit'); }
el('detail').addEventListener('input', onDetailInput);
installSlider('detail', { track: 'detail-track', grip: 'detail-grip',
                          min: 1, max: DETAIL.length, step: 1, onChange: onDetailInput });

// ============================================================ output scale

// Auto-fill only while the fields are still the app's. Once the user has typed
// in one, orbiting the preview must not overwrite what they typed.
function refreshExportSizes() {
    if (!Input) return;
    if (sizeTouched) {
        el('size-src').textContent = 'Your sizes. Reload the file to restore.';
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
    if (!text) return copyNote('Nothing to copy', true);
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
    copyNote(ok ? 'Copied' : 'Code selected \u2014 press Cmd/Ctrl+C', !ok);
}

function scadFileName() {
    return String(FileName).replace(/\.stl$/i, '').replace(/[^\w.-]+/g, '_') + '.scad';
}

function downloadScad() {
    const text = el('scad-out').value;
    if (!text) return copyNote('Nothing to download', true);
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

// Yields where a stage ends, so the locals in scope are the whole state.
function* runFitSteps() {
    if (!Input) yield* ensureInputSteps();
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
    yield;

    const grid = FIT.evalGrid(fit, W, H);
    yield;
    const st = REPORT.stats(z, grid, mask, W, H, uScale());
    const lift = REPORT.liftContour(fit, contour, z, W, H, uScale());
    const patches = FIT.toBezierPatches(fit);
    yield;

    LastFit = { fit, grid, st, lift, patches };
    state.fit = 'ok';

    drawSurface(grid);
    emitScad();
    // A new fit is a new error field; the cache must not survive a refit.
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
        `  rms ${(100 * st.rms / uScale()).toFixed(2)}% of relief,` +
            ` ${(st.n / dof).toFixed(0)} px/DOF`,
        '',
        'CONTOUR LIFT',
        contour.length
            ? `  ${contour.length} outline pts    rms ${fe(lift.rms)}    max ${fe(lift.max)}`
            : '  no outline traced',
        contour.length && lift.rms > 2 * st.rms
            ? '  ! boundary error over 2x the interior rms'
            : '',
        '',
        'EXTRAPOLATION outside the mask  (z is 0..1 inside)',
        st.extrapMin === null
            ? '  none'
            : `  z range ${st.extrapMin.toFixed(2)} .. ${st.extrapMax.toFixed(2)}` +
              (Math.max(-st.extrapMin, st.extrapMax - 1) > 1
                  ? '   ! unbounded'
                  : '   bounded'),
    ].join('\n');
}

// ============================================================= stage 2 warp

function* runWarpSteps() {
    if (!LastFit) throw new Error('no fitted surface yet');
    const { W, H, z, mask, contour } = Input;

    // Compute time, not wall clock: the warp is spread over frames now, and
    // the gaps between slices are not work this report should be charging it.
    const t0 = SlicedMs;
    const w = yield* WARP.warpFitSteps(LastFit.fit, contour, W, H, {
        degree: detailParams().degree,
        domain: WARP_DOMAIN,
        searchCorners: WARP_SEARCH_CORNERS,
        hoschek: WARP_HOSCHEK,
        lambda: WARP_LAMBDA,
        zScale: uScale(),
        mask,
    });
    const tWarp = SlicedMs - t0;
    yield;

    // The output has to be a closed solid. It is a shell: the surface and a
    // copy offset straight down. Two graphs of z = f(x,y) a constant apart
    // cannot meet -- but only where the surface IS a graph. Where the
    // (u,v) -> (x,y) map reverses, the sheet lies over itself and the offset
    // copy cuts through it. Still edge-manifold, so nothing downstream
    // catches it.
    //
    // Only deep reversals count: REPORT.surfaceStats uses a 15% band. A rim
    // fold costs a sliver of the footprint, a fold through the middle an order
    // of magnitude more. Refusing rim folds too would refuse smooth blobs.
    //
    // Thrown, not warned about: reuses the silent fallback in runFrom().
    // Scale-free -- the sign of a Jacobian determinant is unchanged by a
    // positive scale on each axis -- so the size boxes cannot affect it.
    const fold = REPORT.surfaceStats([w.patch], 1, 1, 1);
    if (fold.deepFolded > 0) {
        throw new Error('outline patch self-intersects (' +
            fold.deepFolded + '/' + fold.samples + ' samples reversed)');
    }

    // Compare against the ORIGINAL height field, not against f -- that is the
    // number that answers "how good is the final patch".
    yield;
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
    yield;

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
        'BOUNDARY  (curves vs traced outline)',
        `  xy  ${w.boundary.xyPx.map((v) => v.toFixed(2)).join(' / ')} px per side` +
            `   worst ${w.boundary.xyPxMax.toFixed(2)} px`,
        `  z   ${w.boundary.zGrey.map((v) => fe(v)).join(' / ')} per side` +
            `   worst ${fe(w.boundary.zGreyMax)}`,
        '',
        'DOMAIN MAP  (det J reversals = folds)',
        `  det J ranges ${it.detMin.toFixed(3)} .. ${it.detMax.toFixed(3)}` +
            `   orientation ${it.orientation > 0 ? '+' : '-'}`,
        `  ${it.folded} of ${it.samples} samples reversed (${pct(it.folded, it.samples)})` +
            `  -- ${fw.corner} at corners, ${fw.edge} on edges, ${fw.interior} strictly interior`,
        fw.interior === 0
            ? '  interior reversals 0'
            : `  ! ${fw.interior} interior reversals - lower the degree`,
        w.harmonic
            ? `  relaxed map itself: ${(100 * w.harmonic.fold.foldFraction).toFixed(1)}% reversed`
            : '',
        '',
        'INTERIOR HEIGHTS  (warped patch vs stage-1 f)',
        `  area-weighted rms ${fe(it.rms)}` +
            `    parameter-space rms ${it.rmsUnweighted.toFixed(3)}`,
        `  ${it.outside}/${it.samples} samples outside the mask (down-weighted)`,
        '',
        'END TO END  (warped patch vs height field)',
        `  rms ${fe(e2e)} over ${covIn} px    coverage ${pct(covIn, maskN)} of the mask`,
        `  stage 1 alone ${fe(LastFit.st.rms)},` +
            ` warp ${(e2e - LastFit.st.rms >= 0 ? '+' : '')}${fe(e2e - LastFit.st.rms)}`,
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
        window.__beziverBootError('Page failed to start: ' + err.message +
                                  '. Reload with Shift held.');
    }
    throw err;
}
})();
