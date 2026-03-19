// ─────────────────────────────────────────────
// app.js — Main entry point
// Assembles the PetiteVue App by delegating to
// focused module objects (CanvasManager, Matcher…)
// ─────────────────────────────────────────────

const { createApp } = PetiteVue;

let openCvReadyPromise = null;

function ensureOpenCvReady(timeoutMs = 20000) {
    if (openCvReadyPromise) return openCvReadyPromise;

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const getCv = () => (typeof window !== 'undefined' ? window.cv : (typeof cv !== 'undefined' ? cv : undefined));
    const isReady = (ref) => !!ref && typeof ref.Mat === 'function' && typeof ref.imread === 'function';

    openCvReadyPromise = (async () => {
        const start = Date.now();

        while (Date.now() - start <= timeoutMs) {
            let ref = getCv();

            // Some builds expose cv as a Promise-like object first.
            if (ref && typeof ref.then === 'function') {
                try {
                    const resolved = await Promise.race([ref, wait(1000)]);
                    if (resolved) {
                        if (typeof window !== 'undefined') window.cv = resolved;
                        ref = resolved;
                    }
                } catch (_error) {
                    // Ignore and continue polling.
                }
            }

            // Emscripten style: cv.ready Promise resolves when runtime is initialized.
            if (ref && ref.ready && typeof ref.ready.then === 'function') {
                try {
                    const resolvedReady = await Promise.race([ref.ready.then(() => true), wait(200)]);
                    if (resolvedReady && typeof window !== 'undefined' && window.cv && window.cv !== ref) {
                        ref = window.cv;
                    }
                } catch (_error) {
                    // Ignore and continue polling.
                }
            }

            if (isReady(ref)) return;
            await wait(30);
        }

        throw new Error('OpenCV runtime init timeout');
    })().catch((error) => {
        // Allow retry if initialization failed once.
        openCvReadyPromise = null;
        throw error;
    });

    return openCvReadyPromise;
}

function App() {
    return {
        // ── Reactive UI state ──
        statusText: UIText.STATUS.INIT,
        cropStatus: UIText.CROP.DRAG_TO_SELECT,
        cropCancelButtonText: UIText.CROP.CANCEL_UPLOAD,
        cropConfirmButtonText: UIText.CROP.CONFIRM_UPLOAD,
        cropper: null,
        showCrop: false,
        showBrightnessEnhanceOption: false,
        cropInputOriginalCanvas: null,
        cropEditMode: false,
        cropCanUndo: false,
        cropCanRedo: false,
        cropBrushSize: 36,
        cropEditOriginalCanvas: null,
        isProcessing: false,
        isDragging: false,
        hasOutput: false,
        currentMapKey: 'map02',
        showOriginalBase: true,
        enhanceMapBoundaryBrightness: false,
        previewIncludeBase: true,
        showPreviewModal: false,
        showConfirmModal: false,
        confirmModalTitle: UIText.MODAL.SWITCH_MAP_TITLE,
        confirmModalMessage: UIText.MODAL.SWITCH_MAP_MESSAGE,
        confirmModalConfirmText: UIText.MODAL.CONFIRM,
        confirmModalCancelText: UIText.MODAL.CANCEL,
        _confirmModalResolver: null,
        showInstructions: false,
        showUpdateLog: false,
        appVersion: 'v1.1.0.1',
        changelogEntries: [],
        isChangelogLoading: true,
        changelogLoadError: '',
        isLoadingBaseMap: false,
        isExporting: false,
        exportProgress: 0,
        exportBlob: null,
        exportFormat: 'image/webp',
        exportQuality: 0.95,
        exportCropTransparent: true,
        previewInfo: { width: 0, height: 0, size: '' },
        history: [],
        canUndo: false,
        isOpenCvInitialized: false,

        // ── Lifecycle ──
        async onOpenCvReady() {
            if (this.isOpenCvInitialized) return;
            this.statusText = UIText.STATUS.OPENCV_INITIALIZING;
            await ensureOpenCvReady();
            this.isOpenCvInitialized = true;
            await MapLoader.loadBaseMapFromAsset(this, this.currentMapKey);
        },

        mounted() {
            window.__appState = this;
            this.init();
            this.loadChangelog();
            if (window.__opencvPending) {
                this.onOpenCvReady().catch((error) => {
                    console.error('OpenCV initialization failed', error);
                    this.statusText = UIText.STATUS.OPENCV_INIT_FAILED;
                });
            }
        },

        async loadChangelog() {
            this.isChangelogLoading = true;
            this.changelogLoadError = '';

            if (!window.ChangelogLoader || typeof window.ChangelogLoader.load !== 'function') {
                this.isChangelogLoading = false;
                this.changelogLoadError = UIText.STATUS.CHANGELOG_LOAD_FAILED;
                return;
            }

            try {
                const parsed = await window.ChangelogLoader.load('CHANGELOG.md');
                this.changelogEntries = parsed.entries || [];
                if (parsed.currentVersion) {
                    this.appVersion = parsed.currentVersion;
                }
            } catch (error) {
                console.warn('Changelog load failed', error);
                this.changelogLoadError = UIText.STATUS.CHANGELOG_LOAD_FAILED;
            } finally {
                this.isChangelogLoading = false;
            }
        },

        init() {
            // ── Workers ──
            if (window.Worker && ENABLE_MATCH_WORKERS) {
                workers.forEach(w => w.terminate());
                workers = [];
                const coreCount = navigator.hardwareConcurrency || 2;
                const workerCount = Math.min(2, coreCount);
                console.log(`Initializing ${workerCount} workers (Cores: ${coreCount})`);
                for (let i = 0; i < workerCount; i++) {
                    try { workers.push(new Worker('src/worker.js')); }
                    catch (e) { console.error('Failed to init worker', e); }
                }
            } else {
                workers.forEach(w => w.terminate());
                workers = [];
                console.log('Worker matching disabled; running on main thread for testing.');
            }

            // ── Canvas references ──
            outputCanvas = document.getElementById('outputCanvas');
            outputCtx = outputCanvas.getContext('2d');
            baseCanvas = document.getElementById('baseCanvas');
            baseCtx = baseCanvas.getContext('2d');
            originalBaseCanvas = document.getElementById('originalBaseCanvas');
            originalBaseCtx = originalBaseCanvas.getContext('2d');
            previewCanvas = document.getElementById('previewCanvas');
            previewCtx = previewCanvas.getContext('2d');
            dropZoneEl = document.getElementById('dropZone');
            contentEl = document.querySelector('.content');
            toolbarEl = document.querySelector('.toolbar');
            const cropEditCanvas = document.getElementById('cropEditCanvas');

            if (cropEditCanvas) {
                cropEditCanvas.addEventListener('pointerdown', (e) => CropperHandler.startCropErase(this, e));
                cropEditCanvas.addEventListener('pointermove', (e) => CropperHandler.moveCropErase(this, e));
                cropEditCanvas.addEventListener('pointerup', () => CropperHandler.endCropErase(this));
                cropEditCanvas.addEventListener('pointercancel', () => CropperHandler.endCropErase(this));
                cropEditCanvas.addEventListener('pointerleave', () => CropperHandler.endCropErase(this));
            }

            // ── Drop zone events ──
            const prevent = (e) => { e.preventDefault(); e.stopPropagation(); };
            ['dragenter', 'dragover'].forEach(evt => dropZoneEl.addEventListener(evt, (e) => {
                prevent(e);
                if (!this.isProcessing) this.isDragging = true;
            }));
            ['dragleave', 'drop'].forEach(evt => dropZoneEl.addEventListener(evt, (e) => {
                prevent(e);
                if (evt === 'dragleave' && e.relatedTarget && dropZoneEl.contains(e.relatedTarget)) return;
                this.isDragging = false;
            }));
            dropZoneEl.addEventListener('drop', (e) => {
                if (this.isProcessing) return;
                const file = e.dataTransfer.files?.[0];
                if (file) CropperHandler.openCropWithFile(this, file);
            });

            // ── Canvas interaction events ──
            outputCanvas.addEventListener('wheel',        (e) => CanvasManager.onZoom(e, this.hasOutput, this.showOriginalBase), { passive: false });
            outputCanvas.addEventListener('pointerdown',  (e) => CanvasManager.startPan(e, this.hasOutput));
            outputCanvas.addEventListener('dblclick',     () => CanvasManager.resetView(this.showOriginalBase));
            outputCanvas.addEventListener('pointermove',  (e) => CanvasManager.movePan(e, this.showOriginalBase));
            outputCanvas.addEventListener('pointerup',    (e) => CanvasManager.endPan(e));
            outputCanvas.addEventListener('pointercancel',(e) => CanvasManager.endPan(e));
            outputCanvas.addEventListener('pointerleave', (e) => CanvasManager.endPan(e));

            window.addEventListener('resize', () => CanvasManager.resizeOutputCanvas(this.showOriginalBase));
            if (window.ResizeObserver) {
                dropZoneObserver = new ResizeObserver(() => CanvasManager.resizeOutputCanvas(this.showOriginalBase));
                dropZoneObserver.observe(dropZoneEl);
            }
            CanvasManager.resizeOutputCanvas(this.showOriginalBase);

            // ── Paste from clipboard ──
            document.addEventListener('paste', (e) => {
                for (const item of e.clipboardData?.items || []) {
                    if (item.kind === 'file' && item.type.startsWith('image/')) {
                        const file = item.getAsFile();
                        if (file && !this.isProcessing) { CropperHandler.openCropWithFile(this, file); break; }
                    }
                }
            });

            // ── Keyboard shortcuts ──
            document.addEventListener('keydown', (e) => {
                const key = e.key.toLowerCase();
                const hasShortcutModifier = e.ctrlKey || e.metaKey;

                if (hasShortcutModifier && !e.shiftKey && key === 'z') {
                    // Main view undo: only when no modal is open.
                    if (!this.showCrop && !this.showPreviewModal && !this.showConfirmModal) {
                        e.preventDefault();
                        this.undoLastAction();
                        return;
                    }
                }

                if (hasShortcutModifier && !e.shiftKey && key === 's') {
                    // Main view export: same behavior as the toolbar download button.
                    if (!this.showCrop && !this.showPreviewModal && !this.showConfirmModal) {
                        e.preventDefault();
                        this.openPreviewModal();
                        return;
                    }
                }

                if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Enter') {
                    // Upload crop dialog: Enter confirms crop/upload.
                    if (this.showCrop && cropMode === 'input') {
                        e.preventDefault();
                        this.confirmCrop();
                        return;
                    }

                    // Export preview dialog: Enter starts export.
                    if (this.showPreviewModal && !this.showCrop && !this.isExporting && !this.exportBlob) {
                        e.preventDefault();
                        this.startExportProcess();
                        return;
                    }
                }

                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
                    if (this.showCrop) {
                        e.preventDefault();
                        this.selectAllCrop();
                    }
                }

                if (!this.showCrop || !this.cropEditMode) return;

                if ((e.ctrlKey || e.metaKey) && !e.shiftKey && key === 'z') {
                    e.preventDefault();
                    this.undoCropEdit();
                } else if ((e.ctrlKey || e.metaKey) && (key === 'y' || (e.shiftKey && key === 'z'))) {
                    e.preventDefault();
                    this.redoCropEdit();
                }
            });

            window.addEventListener('resize', () => CropperHandler.renderCropEditCanvas(this));
        },

        // ── Map selection ──
        async selectMap(key)        { await MapLoader.selectMap(this, key); },
        openConfirmModal(title, message, confirmText = UIText.MODAL.CONFIRM, cancelText = UIText.MODAL.CANCEL) {
            this.confirmModalTitle = title;
            this.confirmModalMessage = message;
            this.confirmModalConfirmText = confirmText;
            this.confirmModalCancelText = cancelText;
            this.showConfirmModal = true;
            return new Promise((resolve) => {
                this._confirmModalResolver = resolve;
            });
        },
        confirmModalAction() {
            this.showConfirmModal = false;
            const resolver = this._confirmModalResolver;
            this._confirmModalResolver = null;
            if (resolver) resolver(true);
        },
        cancelModalAction() {
            this.showConfirmModal = false;
            const resolver = this._confirmModalResolver;
            this._confirmModalResolver = null;
            if (resolver) resolver(false);
        },

        // ── View toggles ──
        onOriginalToggle() {
            CanvasManager.rebuildCompositeCanvas(this);
            CanvasManager.renderView(this.showOriginalBase);
        },
        onPreviewBaseToggle()       { ExportHandler.updatePreview(this); },

        // ── File / Crop ──
        openFilePicker()            { CropperHandler.openFilePicker(this); },
        onSubFileChange(e)          { CropperHandler.onSubFileChange(this, e); },
        resetCrop()                 { CropperHandler.resetCrop(this); },
        selectAllCrop()             { CropperHandler.selectAllCrop(this); },
        async toggleCropEditMode()  { await CropperHandler.toggleCropEditMode(this); },
        refreshCropBrushCursor()    { CropperHandler.updateCropEditCursor(this); },
        undoCropEdit()              { CropperHandler.undoCropEdit(this); },
        redoCropEdit()              { CropperHandler.redoCropEdit(this); },
        cancelCrop()                { CropperHandler.cancelCrop(this); },
        async confirmCrop()         { await CropperHandler.confirmCrop(this); },
        async openPreviewCrop()     { await CropperHandler.openPreviewCrop(this); },
        clearPreviewCrop()          { CropperHandler.clearPreviewCrop(this); },
        async onEnhanceBoundaryToggle(event) { await CropperHandler.onEnhanceBoundaryToggle(this, event); },

        // ── History ──
        undoLastAction()            { History.undoLastAction(this); },
        reopenLastImageForCrop() {
            if (!this.canUndo || this.isProcessing || this.isLoadingBaseMap) return;
            const lastAction = this.history[this.history.length - 1];
            if (!lastAction?.originalCanvas) return;
            if (lastAction.wasBoundaryEnhanced) {
                // Re-cropping an already enhanced image should default to disabled
                // to avoid applying boundary enhancement twice.
                this.enhanceMapBoundaryBrightness = false;
            }
            // 先得到 canvas 引用再 undo，防止 undo 內部釋放
            const canvas = lastAction.originalCanvas;
            History.undoLastAction(this);
            CropperHandler.openCropWithCanvas(this, canvas);
        },

        // ── Export / Preview ──
        openPreviewModal()          { ExportHandler.openPreviewModal(this); },
        closePreviewModal()         { ExportHandler.closePreviewModal(this); },
        async updatePreview()       { await ExportHandler.updatePreview(this); },
        async startExportProcess()  { await ExportHandler.startExportProcess(this); },
        downloadExportedBlob()      { ExportHandler.downloadExportedBlob(this); },

        // ── View ──
        resetView()                 { CanvasManager.resetView(this.showOriginalBase); },
        renderView()                { CanvasManager.renderView(this.showOriginalBase); },
    };
}

// ── Bootstrap ──
createApp({ App }).mount('#app');

window.__opencvReady = async () => {
    if (window.__appState?.onOpenCvReady) {
        try {
            await window.__appState.onOpenCvReady();
        } catch (error) {
            console.error('OpenCV initialization failed', error);
            if (window.__appState) window.__appState.statusText = UIText.STATUS.OPENCV_INIT_FAILED;
        }
    } else {
        window.__opencvPending = true;
    }
};
