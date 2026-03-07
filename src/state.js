// ─────────────────────────────────────────────
// Global constants & shared mutable state
// Accessed by all other modules
// ─────────────────────────────────────────────

const SCALE_DOWN = 0.5;

const MAPS = {
    map01: { file: 'assets/map01.webp', name: '四號谷地' },
    map02: { file: 'assets/map02.webp', name: '武陵' }
};

const yieldToUI = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

// ── OpenCV Mats ──
let baseMat = null;
let originalBaseMat = null;
let grayBase = null;
let baseAlphaMask = null;
let searchBase = null;

// ── Canvas elements ──
let outputCanvas = null;
let outputCtx = null;
let baseCanvas = null;
let baseCtx = null;
let originalBaseCanvas = null;
let originalBaseCtx = null;
let overlayCanvas = null;
let overlayCtx = null;
let previewCanvas = null;
let previewCtx = null;
let dropZoneEl = null;
let contentEl = null;
let toolbarEl = null;
let dropZoneObserver = null;

// ── View state ──
let isPanning = false;
let panStart = { x: 0, y: 0 };
let viewOffset = { x: 0, y: 0 };
let viewScale = 1;
let minViewScale = 0.2;

// ── App state ──
let hasOverlay = false;
let cropMode = 'input';
let previewCropRect = null;
let currentFileCallback = null;

// ── Workers ──
let workers = [];
