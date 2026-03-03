// ─────────────────────────────────────────────
// app.js — Main entry point
// Assembles the PetiteVue App by delegating to
// focused module objects (CanvasManager, Matcher…)
// ─────────────────────────────────────────────

const { createApp } = PetiteVue;

function App() {
    return {
        // ── Reactive UI state ──
        statusText: '正在初始化... ',
        cropStatus: '請拖拽選擇要裁剪的區域',
        showCrop: false,
        isProcessing: false,
        isDragging: false,
        hasOutput: false,
        currentMapKey: 'map02',
        showOriginalBase: true,
        previewIncludeBase: true,
        showPreviewModal: false,
        showConfirmModal: false,
        showRematchModal: false,
        rematchType: 'smaller',
        showInstructions: true,
        showUpdateLog: false,
        isLoadingBaseMap: false,
        isExporting: false,
        exportProgress: 0,
        exportBlob: null,
        exportFormat: 'image/webp',
        exportQuality: 0.95,
        exportCropTransparent: true,
        previewInfo: { width: 0, height: 0, size: '' },
        pendingMapKey: null,
        history: [],
        canUndo: false,

        // ── Lifecycle ──
        async onOpenCvReady() {
            await MapLoader.loadBaseMapFromAsset(this, this.currentMapKey);
        },

        mounted() {
            window.__appState = this;
            this.init();
            if (window.__opencvPending) this.onOpenCvReady();
        },

        init() {
            // ── Workers ──
            if (window.Worker) {
                workers.forEach(w => w.terminate());
                workers = [];
                const coreCount = navigator.hardwareConcurrency || 2;
                const workerCount = Math.min(2, coreCount);
                console.log(`Initializing ${workerCount} workers (Cores: ${coreCount})`);
                for (let i = 0; i < workerCount; i++) {
                    try { workers.push(new Worker('src/worker.js')); }
                    catch (e) { console.error('Failed to init worker', e); }
                }
            }

            // ── Canvas references ──
            outputCanvas = document.getElementById('outputCanvas');
            outputCtx = outputCanvas.getContext('2d');
            baseCanvas = document.getElementById('baseCanvas');
            baseCtx = baseCanvas.getContext('2d');
            originalBaseCanvas = document.getElementById('originalBaseCanvas');
            originalBaseCtx = originalBaseCanvas.getContext('2d');
            overlayCanvas = document.getElementById('overlayCanvas');
            overlayCtx = overlayCanvas.getContext('2d');
            previewCanvas = document.getElementById('previewCanvas');
            previewCtx = previewCanvas.getContext('2d');
            dropZoneEl = document.getElementById('dropZone');
            contentEl = document.querySelector('.content');
            toolbarEl = document.querySelector('.toolbar');

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
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
                    if (this.showCrop) {
                        e.preventDefault();
                        this.selectAllCrop();
                    }
                }
            });
        },

        // ── Map selection ──
        async selectMap(key)        { await MapLoader.selectMap(this, key); },
        async confirmMapSwitch()    { await MapLoader.confirmMapSwitch(this); },
        cancelMapSwitch()           { MapLoader.cancelMapSwitch(this); },
        async onMapChange(e)        { await this.selectMap(e.target.value); },

        // ── View toggles ──
        onOriginalToggle()          { CanvasManager.renderView(this.showOriginalBase); },
        onPreviewBaseToggle()       { ExportHandler.updatePreview(this); },

        // ── File / Crop ──
        openFilePicker()            { CropperHandler.openFilePicker(this); },
        onSubFileChange(e)          { CropperHandler.onSubFileChange(this, e); },
        resetCrop()                 { CropperHandler.resetCrop(this); },
        selectAllCrop()             { CropperHandler.selectAllCrop(this); },
        cancelCrop()                { CropperHandler.cancelCrop(this); },
        async confirmCrop()         { await CropperHandler.confirmCrop(this); },
        async openPreviewCrop()     { await CropperHandler.openPreviewCrop(this); },
        clearPreviewCrop()          { CropperHandler.clearPreviewCrop(this); },

        // ── History ──
        undoLastAction()            { History.undoLastAction(this); },
        openRematchModal() {
            if (!this.canUndo || this.isProcessing) return;
            this.rematchType = 'smaller';
            this.showRematchModal = true;
        },
        async confirmRematch() {
            this.showRematchModal = false;
            const lastAction = this.history[this.history.length - 1];
            if (!lastAction || !lastAction.originalCanvas) return;
            
            // Undo visual state but keep the original canvas
            const origCanvas = lastAction.originalCanvas;
            const scale = lastAction.scale; // Assuming we stored the found scale
            this.undoLastAction();
            
            let customLevel0 = null;
            if (this.rematchType === 'smaller') {
                customLevel0 = { scaleRange: { min: 0.5, max: scale * 0.95 }, step: 0.1, status: '搜尋更小比例中' };
            } else if (this.rematchType === 'larger') {
                customLevel0 = { scaleRange: { min: scale * 1.05, max: 5 }, step: 0.1, status: '搜尋更大比例中' };
            }

            await Matcher.processScreenshotAfterCrop(this, origCanvas, customLevel0);
        },

        // ── Export / Preview ──
        openPreviewModal()          { ExportHandler.openPreviewModal(this); },
        closePreviewModal()         { ExportHandler.closePreviewModal(this); },
        async updatePreview()       { await ExportHandler.updatePreview(this); },
        async startExportProcess()  { await ExportHandler.startExportProcess(this); },
        downloadExportedBlob()      { ExportHandler.downloadExportedBlob(this); },
        downloadImage()             { ExportHandler.downloadImage(this); },

        // ── View ──
        resetView()                 { CanvasManager.resetView(this.showOriginalBase); },
        renderView()                { CanvasManager.renderView(this.showOriginalBase); },
    };
}

// ── Bootstrap ──
const app = createApp({ App }).mount('#app');

window.__opencvReady = async () => {
    if (window.__appState?.onOpenCvReady) {
        await window.__appState.onOpenCvReady();
    } else {
        window.__opencvPending = true;
    }
};
