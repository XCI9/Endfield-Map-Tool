const { createApp } = PetiteVue;

let baseMat = null;
let originalBaseMat = null;
let grayBase = null;
let searchBase = null;

const SCALE_DOWN = 0.5;

// Variables replaced by Cropper.js logic:
// cropCanvas, cropCtx, cropStart, cropEnd, imageDisplayScale, isDrawing

let currentImage = null;
let currentFileCallback = null;
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
let isPanning = false;
let panStart = { x: 0, y: 0 };
let viewOffset = { x: 0, y: 0 };
let viewScale = 1;
let minViewScale = 0.2;
let hasOverlay = false;
let cropMode = 'input';
let previewCropRect = null;

const MAPS = {
    map01: { file: 'assets/map01.webp', name: '四號谷地' },
    map02: { file: 'assets/map02.webp', name: '武陵' }
};

const yieldToUI = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

function App() {
    const state = {
        statusText: '正在初始化... ',
        cropStatus: '請拖拽選擇要裁剪的區域',
        showCrop: false,
        isProcessing: false,
        isDragging: false,
        hasOutput: false,
        // Make hasOverlay accessible to state logic or keep relying on module scope variable is risky if reactivity needed.
        // But selectMap is inside methods, so it can clear access `hasOverlay`.
        // However, `hasOverlay` is not reactive, so if we rely on it for UI, it's bad.
        // But here we only check it in `selectMap`.
        currentMapKey: 'map02',
        showOriginalBase: true,
        previewIncludeBase: true,
        showPreviewModal: false,
        showConfirmModal: false,
        pendingMapKey: null,
        history: [], // Stores { canvas: HTMLCanvasElement, rect: {x,y,w,h} }
        canUndo: false,
        async onOpenCvReady() {
            await this.loadBaseMapFromAsset(this.currentMapKey);
        },
        mounted() {
            window.__appState = this;
            this.init();
            if (window.__opencvPending) {
                this.onOpenCvReady();
            }
        },
        init() {
            // cropCanvas and cropCtx are replaced by Cropper.js on #cropImage
            outputCanvas = document.getElementById('outputCanvas');
            outputCtx = outputCanvas.getContext('2d');
            baseCanvas = document.getElementById('baseCanvas');
            baseCtx = baseCanvas.getContext('2d');
            originalBaseCanvas = document.getElementById('originalBaseCanvas');
            originalBaseCtx = originalBaseCanvas.getContext('2d');
            
            // This overlay canvas is for temporal display or debugging, currently used to show the LAST added overlay only in some cases
            // but we want a cumulative one. Let's hijack it or create a new one.
            // The existing overlayCanvas is actually `cumulativeOverlayCanvas` effectively if we don't clear it every time.
            overlayCanvas = document.getElementById('overlayCanvas');
            overlayCtx = overlayCanvas.getContext('2d');

            previewCanvas = document.getElementById('previewCanvas');
            previewCtx = previewCanvas.getContext('2d');
            dropZoneEl = document.getElementById('dropZone');
            contentEl = document.querySelector('.content');
            toolbarEl = document.querySelector('.toolbar');

            const dropZone = dropZoneEl;
            const prevent = (e) => {
                e.preventDefault();
                e.stopPropagation();
            };

            ['dragenter', 'dragover'].forEach((evt) => {
                dropZone.addEventListener(evt, (e) => {
                    prevent(e);
                    if (this.isProcessing) return;
                    this.isDragging = true;
                });
            });

            ['dragleave', 'drop'].forEach((evt) => {
                dropZone.addEventListener(evt, (e) => {
                    prevent(e);
                    
                    if (evt === 'dragleave') {
                        // Check if we are really leaving the drop zone (e.relatedTarget should be null or outside)
                        if (e.relatedTarget && dropZone.contains(e.relatedTarget)) {
                            return;
                        }
                    }
                    this.isDragging = false;
                });
            });

            dropZone.addEventListener('drop', (e) => {
                if (this.isProcessing) return;
                const file = e.dataTransfer.files?.[0];
                if (file) {
                    this.openCropWithFile(file);
                }
            });

            outputCanvas.addEventListener('wheel', (e) => this.onZoom(e), { passive: false });
            outputCanvas.addEventListener('pointerdown', (e) => this.startPan(e));
            outputCanvas.addEventListener('dblclick', () => this.resetView());
            outputCanvas.addEventListener('pointermove', (e) => this.movePan(e));
            outputCanvas.addEventListener('pointerup', (e) => this.endPan(e));
            outputCanvas.addEventListener('pointercancel', (e) => this.endPan(e));
            outputCanvas.addEventListener('pointerleave', (e) => this.endPan(e));

            window.addEventListener('resize', () => this.resizeOutputCanvas());
            if (window.ResizeObserver) {
                dropZoneObserver = new ResizeObserver(() => this.resizeOutputCanvas());
                dropZoneObserver.observe(dropZoneEl);
            }
            this.resizeOutputCanvas();

            document.addEventListener('paste', (e) => {
                const items = e.clipboardData?.items || [];
                for (const item of items) {
                    if (item.kind === 'file' && item.type.startsWith('image/')) {
                        const file = item.getAsFile();
                        if (file) {
                            if (this.isProcessing) return;
                            this.openCropWithFile(file);
                            break;
                        }
                    }
                }
            });
        },
        openFilePicker() {
            if (this.isProcessing) return;
            this.$refs.subFile.value = '';
            this.$refs.subFile.click();
        },
        onSubFileChange(e) {
            const file = e.target.files?.[0];
            if (file) {
                this.openCropWithFile(file);
            }
        },
        async loadBaseMapFromAsset(mapKey) {
            const mapInfo = MAPS[mapKey] || MAPS.map02;
            this.statusText = `⏳ 載入基底地圖 ${mapInfo.name} 中...`;

            const img = new Image();
            const loadPromise = new Promise((resolve, reject) => {
                img.onload = () => resolve();
                img.onerror = reject;
            });
            img.src = mapInfo.file;

            try {
                await loadPromise;
                if (img.decode) {
                    await img.decode().catch(() => undefined);
                }
            } catch (error) {
                this.statusText = `❌ 無法載入基底地圖：${mapInfo.name}。請確認 ${mapInfo.file} 是否存在。`;
                return;
            }

            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);

            if (baseMat) baseMat.delete();
            if (originalBaseMat) originalBaseMat.delete();
            if (grayBase) grayBase.delete();
            if (searchBase) searchBase.delete();

            baseMat = cv.imread(canvas);
            originalBaseMat = baseMat.clone();
            grayBase = new cv.Mat();
            cv.cvtColor(baseMat, grayBase, cv.COLOR_RGBA2GRAY);

            this.syncBaseCanvasSizes();
            cv.imshow('baseCanvas', baseMat);
            cv.imshow('originalBaseCanvas', originalBaseMat);
            
            // Clear history when base map changes
            this.history = [];
            this.canUndo = false;
            
            this.resetOverlayCanvas();
            this.hasOutput = true;
            this.resetView();
            this.renderView();
            this.updatePreview();
            this.statusText = `✅ 基底地圖已載入：${mapInfo.name}，請上傳截圖`;
        },
        async selectMap(key) {
            if (this.isProcessing) return;
            if (this.currentMapKey === key) return;

            // Check if there's an existing overlay (uploaded content)
            if (hasOverlay) {
                this.pendingMapKey = key;
                this.showConfirmModal = true;
                return;
            }
            
            this.currentMapKey = key;
            await this.loadBaseMapFromAsset(key);
        },
        async confirmMapSwitch() {
            this.showConfirmModal = false;
            if (this.pendingMapKey) {
                this.currentMapKey = this.pendingMapKey;
                this.pendingMapKey = null;
                await this.loadBaseMapFromAsset(this.currentMapKey);
            }
        },
        cancelMapSwitch() {
            this.showConfirmModal = false;
            this.pendingMapKey = null;
        },
        async onMapChange(event) {
            const mapKey = event.target.value;
            this.selectMap(mapKey);
        },
        onOriginalToggle() {
            this.renderView();
        },
        onPreviewBaseToggle() {
            this.updatePreview();
        },
        async openCropWithFile(file) {
            if (this.isProcessing) return;
            if (!file.type.startsWith('image/')) {
                this.statusText = '❌ 只支援圖片檔案';
                return;
            }

            cropMode = 'input';
            currentFileCallback = this.processScreenshotAfterCrop.bind(this);
            
            // Convert file to URL for Crop display
            const url = URL.createObjectURL(file);
            const img = document.getElementById('cropImage');
            img.src = url;
            
            this.showCrop = true;
            this.cropStatus = '請調整裁剪區域';

            await yieldToUI();
            
            if (this.cropper) {
                this.cropper.destroy();
            }

            this.cropper = new Cropper(img, {
                viewMode: 1,
                movable: true,
                zoomable: true,
                scalable: false,
                rotatable: false,
                restore: false,
                toggleDragModeOnDblclick: false,
            });
        },
        // Removed old manual crop methods
        /*
        startCrop(e) { ... },
        drawCrop(e) { ... },
        drawCropFromWindow(e) { ... },
        endCrop(e) { ... },
        drawCropOverlay() { ... },
        */
        resetCrop() {
            if (this.cropper) {
                this.cropper.reset();
            }
        },
        cancelCrop() {
            this.showCrop = false;
            // Clean up cropper
            if (this.cropper) {
                this.cropper.destroy();
                this.cropper = null;
            }
            this.cropStatus = '請拖拽選擇要裁剪的區域';
        },
        async confirmCrop() {
            if (!this.cropper) return;

            const croppedCanvas = this.cropper.getCroppedCanvas();

            if (!croppedCanvas || croppedCanvas.width < 1 || croppedCanvas.height < 1) {
                this.cropStatus = '裁剪區域過小，請重新選擇。';
                return;
            }

            if (cropMode === 'preview') {
                const data = this.cropper.getData();
                // For preview crop, we just need the rect to apply to the source canvas
                // Wait, `getCroppedCanvas` returns a new canvas. 
                // But `updatePreview` uses `previewCropRect` to draw from `sourceCanvas`.
                // Actually `cropper.getData` returns values relative to the original image size (scale 1).
                // So we can use that.
                
                previewCropRect = {
                    x: Math.round(data.x),
                    y: Math.round(data.y),
                    width: Math.round(data.width),
                    height: Math.round(data.height)
                };

                this.showCrop = false;
                if (this.cropper) {
                    this.cropper.destroy();
                    this.cropper = null;
                }
                this.cropStatus = '請拖拽選擇要裁剪的區域';
                this.updatePreview();
                return;
            }

            this.showCrop = false;
            if (this.cropper) {
                this.cropper.destroy();
                this.cropper = null;
            }
            this.cropStatus = '請拖拽選擇要裁剪的區域';

            await new Promise((resolve) => requestAnimationFrame(() => resolve()));
            await new Promise((resolve) => setTimeout(resolve, 0));

            if (currentFileCallback) {
                await currentFileCallback(croppedCanvas);
            }
        },
        async performTemplateMatch(baseImg, templateImg, scaleDownRes, roi, scaleRange, step, statusPrefix) {
            const searchBase = new cv.Mat();
            cv.resize(baseImg, searchBase, new cv.Size(), scaleDownRes, scaleDownRes, cv.INTER_AREA);

            let searchRoi = searchBase;
            let roiX = 0;
            let roiY = 0;

            if (roi) {
                roiX = Math.max(0, Math.round(roi.x));
                roiY = Math.max(0, Math.round(roi.y));
                const roiW = Math.min(searchBase.cols - roiX, Math.round(roi.width));
                const roiH = Math.min(searchBase.rows - roiY, Math.round(roi.height));
                searchRoi = searchBase.roi(new cv.Rect(roiX, roiY, roiW, roiH));
            }

            let bestVal = -1;
            let bestLoc = null;
            let bestScale = 1;
            let index = 0;

            for (let s = scaleRange.min; s <= scaleRange.max; s += step) {
                const resizedSub = new cv.Mat();
                const finalS = s * scaleDownRes;
                cv.resize(templateImg, resizedSub, new cv.Size(), finalS, finalS, cv.INTER_AREA);

                if (resizedSub.cols <= searchRoi.cols && resizedSub.rows <= searchRoi.rows) {
                    const res = new cv.Mat();
                    cv.matchTemplate(searchRoi, resizedSub, res, cv.TM_CCOEFF_NORMED);
                    const minMax = cv.minMaxLoc(res);

                    if (minMax.maxVal > bestVal) {
                        bestVal = minMax.maxVal;
                        bestLoc = {
                            x: minMax.maxLoc.x + roiX,
                            y: minMax.maxLoc.y + roiY
                        };
                        bestScale = s;
                    }
                    res.delete();
                }
                resizedSub.delete();

                index += 1;
                if (index % 4 === 0) {
                    this.statusText = `⏳ ${statusPrefix}... 比例: ${s.toFixed(2)}`;
                    await yieldToUI();
                }
            }

            if (roi) {
                searchRoi.delete();
            }
            searchBase.delete();

            return { bestVal, bestLoc, bestScale };
        },
        async processScreenshotAfterCrop(canvas) {
            if (this.isProcessing) return;
            if (!grayBase) {
                this.statusText = '❌ 基底地圖尚未載入';
                return;
            }

            this.isProcessing = true;
            try {
                const startTime = performance.now();
                this.statusText = '⏳ 正在搜尋最佳位置與比例...';

                const subMat = cv.imread(canvas);
                const graySub = new cv.Mat();
                cv.cvtColor(subMat, graySub, cv.COLOR_RGBA2GRAY);

                let bestVal = -1;
                let bestLoc = null;
                let bestScale = 1;


                let currentScaleRes = SCALE_DOWN;

                // Search config
                const searchLevels = [
                    {
                        scaleRes: SCALE_DOWN * 0.25,
                        roiMargin: 0, // 0 means full search
                        scaleRange: { min: 0.5, max: 5 },
                        step: 0.2,
                        threshold: 0.2, // Min correlation to proceed
                        status: '粗略搜尋中'
                    },
                    {
                        scaleRes: SCALE_DOWN * 0.5,
                        roiMargin: 30,
                        scaleRange: { range: 0.3 }, // +/- range around bestScale
                        step: 0.05,
                        threshold: 0.3,
                        status: '中等搜尋中'
                    },
                    {
                        scaleRes: SCALE_DOWN,
                        roiMargin: 10,
                        scaleRange: { range: 0.06 },
                        step: 0.01,
                        threshold: 0.3,
                        status: '精確搜尋中'
                    }
                ];

                for (const level of searchLevels) {
                    // If previous level failed to meet threshold (except first level which has no previous), break or handle
                    if (bestVal !== -1 && bestVal < (level.threshold || 0)) {
                        break;
                    }

                    let roi = null;
                    if (level.roiMargin > 0 && bestLoc) {
                        // Calculate ROI based on previous result
                        const ratio = level.scaleRes / currentScaleRes;
                        const prevX = bestLoc.x * ratio;
                        const prevY = bestLoc.y * ratio;
                        const prevW = graySub.cols * bestScale * level.scaleRes;
                        const prevH = graySub.rows * bestScale * level.scaleRes;

                        roi = {
                            x: prevX - level.roiMargin,
                            y: prevY - level.roiMargin,
                            width: prevW + level.roiMargin * 2,
                            height: prevH + level.roiMargin * 2
                        };
                    }

                    let range = level.scaleRange;
                    if (range.range !== undefined && bestScale) {
                        range = {
                            min: Math.max(0.5, bestScale - range.range),
                            max: Math.min(5, bestScale + range.range)
                        };
                    }

                    const result = await this.performTemplateMatch(
                        grayBase,
                        graySub,
                        level.scaleRes,
                        roi,
                        range,
                        level.step,
                        level.status
                    );

                    if (result.bestVal > bestVal) {
                        bestVal = result.bestVal;
                        bestLoc = result.bestLoc;
                        bestScale = result.bestScale;
                        currentScaleRes = level.scaleRes;
                    }
                }
                
                // Normalize bestLoc back to SCALE_DOWN
                if (currentScaleRes !== SCALE_DOWN && bestLoc) {
                    bestLoc = {
                        x: bestLoc.x * (SCALE_DOWN / currentScaleRes),
                        y: bestLoc.y * (SCALE_DOWN / currentScaleRes)
                    };
                }

                if (bestVal > 0.4) {
                    const finalX = Math.round(bestLoc.x / SCALE_DOWN);
                    const finalY = Math.round(bestLoc.y / SCALE_DOWN);
                    const finalW = Math.round(subMat.cols * bestScale);
                    const finalH = Math.round(subMat.rows * bestScale);

                    const finalSub = new cv.Mat();
                    cv.resize(subMat, finalSub, new cv.Size(finalW, finalH));

                    const rect = new cv.Rect(
                        Math.max(0, finalX),
                        Math.max(0, finalY),
                        Math.min(finalW, baseMat.cols - finalX),
                        Math.min(finalH, baseMat.rows - finalY)
                    );

                    const roi = baseMat.roi(rect);
                    const clippedSub = finalSub.roi(new cv.Rect(0, 0, rect.width, rect.height));
                    clippedSub.copyTo(roi);

                    this.syncBaseCanvasSizes();
                    cv.imshow('baseCanvas', baseMat);
                    this.updateOverlayCanvas(finalSub, rect);
                    
                    // Add to history
                    const historyItemCanvas = document.createElement('canvas');
                    historyItemCanvas.width = finalSub.cols;
                    historyItemCanvas.height = finalSub.rows;
                    cv.imshow(historyItemCanvas, finalSub);
                    
                    this.history.push({
                        canvas: historyItemCanvas,
                        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
                    });
                    this.canUndo = true;

                    this.renderView();
                    this.updatePreview();
                    const endTime = performance.now();
                    this.statusText = `✅ 成功！耗時: ${Math.round(endTime - startTime)}ms, 相似度: ${Math.round(bestVal * 100)}%, 縮放比例: ${bestScale.toFixed(2)}`;
                    this.hasOutput = true;
                    this.resetView();

                    roi.delete();
                    clippedSub.delete();
                    finalSub.delete();
                } else {
                    this.statusText = '❌ 找不到匹配位置，請嘗試其他截圖或檢查內容';
                }

                if (searchBase && !searchBase.isDeleted()) {
                    searchBase.delete();
                }
                subMat.delete();
                graySub.delete();
            } finally {
                this.isProcessing = false;
            }
        },
        undoLastAction() {
            if (this.isProcessing) return;
            if (this.history.length === 0) return;

            // Remove last item
            const lastItem = this.history.pop();
            this.canUndo = this.history.length > 0;
            
            // Note: lastItem.canvas is a DOM element, so we don't need to delete it like an OpenCV mat.

            // Restore baseMat
            if (baseMat) baseMat.delete();
            baseMat = originalBaseMat.clone();
            
            // Clear overlay
            this.resetOverlayCanvas();
            
            // Replay history
            for (const item of this.history) {
                // Replay onto baseMat
                const itemMat = cv.imread(item.canvas);
                const roi = baseMat.roi(new cv.Rect(item.rect.x, item.rect.y, item.rect.width, item.rect.height));
                itemMat.copyTo(roi);
                itemMat.delete();
                roi.delete();
                
                // Replay onto overlay
                overlayCtx.drawImage(item.canvas, item.rect.x, item.rect.y, item.rect.width, item.rect.height);
                hasOverlay = true;
            }
            // hasOverlay is updated in loop, but if history is empty now, it remains false (from reset)
            
            cv.imshow('baseCanvas', baseMat);
            this.renderView();
            this.updatePreview();
            this.statusText = '↩️ 已復原上一步操作';
        },
        downloadImage() {
            const sourceCanvas = previewCanvas || baseCanvas;
            if (!sourceCanvas) return;

            const ctx = sourceCanvas.getContext('2d');
            const width = sourceCanvas.width;
            const height = sourceCanvas.height;
            const imageData = ctx.getImageData(0, 0, width, height);
            const data = imageData.data;

            let minX = width, minY = height, maxX = 0, maxY = 0;
            let hasPixels = false;

            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const alpha = data[(y * width + x) * 4 + 3];
                    if (alpha > 0) {
                        if (x < minX) minX = x;
                        if (x > maxX) maxX = x;
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                        hasPixels = true;
                    }
                }
            }

            if (!hasPixels) {
                this.statusText = '❌ 圖片全為透明，無法下載';
                return;
            }

            const cropWidth = maxX - minX + 1;
            const cropHeight = maxY - minY + 1;

            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = cropWidth;
            tempCanvas.height = cropHeight;
            const tempCtx = tempCanvas.getContext('2d');
            tempCtx.drawImage(sourceCanvas, minX, minY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

            const link = document.createElement('a');
            link.download = 'full_map_updated.png';
            link.href = tempCanvas.toDataURL('image/png');
            link.click();
            this.showPreviewModal = false;
        },
        openPreviewModal() {
            this.showPreviewModal = true;
            this.updatePreview();
        },
        closePreviewModal() {
            this.showPreviewModal = false;
        },
        renderView() {
            const sourceCanvas = this.showOriginalBase ? baseCanvas : overlayCanvas;
            if (!outputCanvas || !sourceCanvas || !outputCtx) return;
            this.updateMinScale();
            this.clampViewOffset();
            outputCtx.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
            outputCtx.save();
            outputCtx.translate(viewOffset.x, viewOffset.y);
            outputCtx.scale(viewScale, viewScale);
            outputCtx.drawImage(sourceCanvas, 0, 0);
            outputCtx.restore();
        },
        resetOverlayCanvas() {
            if (!overlayCanvas || !baseMat) return;
            overlayCanvas.width = baseMat.cols;
            overlayCanvas.height = baseMat.rows;
            overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
            hasOverlay = false;
        },
        updateOverlayCanvas(finalSub, rect) {
            if (!overlayCanvas || !overlayCtx || !baseMat) return;
            // Removed clearing logic to make it cumulative
            // overlayCanvas.width = baseMat.cols;
            // overlayCanvas.height = baseMat.rows;
            // overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = finalSub.cols;
            tempCanvas.height = finalSub.rows;
            cv.imshow(tempCanvas, finalSub);
            overlayCtx.drawImage(tempCanvas, rect.x, rect.y, rect.width, rect.height);
            hasOverlay = true;
        },
        updatePreview() {
            if (!previewCanvas || !previewCtx) return;
            const sourceCanvas = this.previewIncludeBase ? baseCanvas : overlayCanvas;
            if (!sourceCanvas) return;

            if (previewCropRect) {
                previewCanvas.width = previewCropRect.width;
                previewCanvas.height = previewCropRect.height;
                previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
                previewCtx.drawImage(
                    sourceCanvas,
                    previewCropRect.x,
                    previewCropRect.y,
                    previewCropRect.width,
                    previewCropRect.height,
                    0,
                    0,
                    previewCropRect.width,
                    previewCropRect.height
                );
                return;
            }

            previewCanvas.width = sourceCanvas.width;
            previewCanvas.height = sourceCanvas.height;
            previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
            previewCtx.drawImage(sourceCanvas, 0, 0);
        },
        async openPreviewCrop() {
            if (!previewCanvas) return;
            cropMode = 'preview';

            // Convert previewCanvas to blob url
            const blob = await new Promise(resolve => previewCanvas.toBlob(resolve));
            const url = URL.createObjectURL(blob);

            const image = document.getElementById('cropImage');
            image.src = url;

            this.showCrop = true;
            this.cropStatus = '請拖拽選擇要裁剪的區域';

            if (this.cropper) {
                this.cropper.destroy();
            }

            // Wait for UI update
            await new Promise(r => setTimeout(r, 50));

            this.cropper = new Cropper(image, {
                viewMode: 1,
                dragMode: 'move',
                autoCropArea: 1,
                restore: false,
                guides: true,
                center: true,
                highlight: false,
                cropBoxMovable: true,
                cropBoxResizable: true,
                toggleDragModeOnDblclick: false,
            });
        },
        clearPreviewCrop() {
            previewCropRect = null;
            this.updatePreview();
        },
        syncBaseCanvasSizes() {
            if (!baseMat) return;
            if (baseCanvas) {
                baseCanvas.width = baseMat.cols;
                baseCanvas.height = baseMat.rows;
            }
            if (originalBaseCanvas && originalBaseMat) {
                originalBaseCanvas.width = originalBaseMat.cols;
                originalBaseCanvas.height = originalBaseMat.rows;
            }
            if (overlayCanvas) {
                // Resize only if strictly necessary to avoid clearing content
                if (overlayCanvas.width !== baseMat.cols || overlayCanvas.height !== baseMat.rows) {
                    overlayCanvas.width = baseMat.cols;
                    overlayCanvas.height = baseMat.rows;
                }
            }
        },
        resizeOutputCanvas() {
            if (!outputCanvas || !dropZoneEl) return;
            if (contentEl && toolbarEl) {
                const toolbarHeight = toolbarEl.getBoundingClientRect().height;
                const contentStyles = getComputedStyle(contentEl);
                const paddingX = parseFloat(contentStyles.paddingLeft) + parseFloat(contentStyles.paddingRight);
                const paddingY = parseFloat(contentStyles.paddingTop) + parseFloat(contentStyles.paddingBottom);

                const viewportWidth = window.innerWidth;
                const viewportHeight = window.innerHeight;

                const nextContentWidth = Math.max(1, viewportWidth - paddingX);
                const nextContentHeight = Math.max(1, viewportHeight - toolbarHeight - paddingY);

                contentEl.style.width = `${nextContentWidth}px`;
                contentEl.style.height = `${nextContentHeight}px`;
            }

            const width = dropZoneEl.clientWidth || dropZoneEl.getBoundingClientRect().width;
            const height = dropZoneEl.clientHeight || dropZoneEl.getBoundingClientRect().height;
            const nextWidth = Math.max(1, Math.floor(width));
            const nextHeight = Math.max(1, Math.floor(height));
            outputCanvas.width = nextWidth;
            outputCanvas.height = nextHeight;
            outputCanvas.style.width = `${nextWidth}px`;
            outputCanvas.style.height = `${nextHeight}px`;
            this.updateMinScale();
            this.renderView();
        },
        updateMinScale() {
            const sourceCanvas = this.showOriginalBase ? baseCanvas : overlayCanvas;
            if (!outputCanvas || !sourceCanvas) return;
            const viewWidth = outputCanvas.width || outputCanvas.clientWidth;
            const viewHeight = outputCanvas.height || outputCanvas.clientHeight;
            const canvasWidth = sourceCanvas.width || sourceCanvas.clientWidth;
            const canvasHeight = sourceCanvas.height || sourceCanvas.clientHeight;

            if (!canvasWidth || !canvasHeight) return;
            const fitX = viewWidth / canvasWidth;
            const fitY = viewHeight / canvasHeight;
            minViewScale = Math.min(fitX, fitY);
            if (viewScale < minViewScale) {
                viewScale = minViewScale;
            }
        },
        resetView() {
            this.updateMinScale();
            viewScale = minViewScale;
            viewOffset = { x: 0, y: 0 };
            this.renderView();
        },
        clampViewOffset() {
            const sourceCanvas = this.showOriginalBase ? baseCanvas : overlayCanvas;
            if (!outputCanvas || !sourceCanvas) return;
            const viewWidth = outputCanvas.width || outputCanvas.clientWidth;
            const viewHeight = outputCanvas.height || outputCanvas.clientHeight;
            const canvasWidth = sourceCanvas.width || sourceCanvas.clientWidth;
            const canvasHeight = sourceCanvas.height || sourceCanvas.clientHeight;

            if (!canvasWidth || !canvasHeight) return;

            const scaledWidth = canvasWidth * viewScale;
            const scaledHeight = canvasHeight * viewScale;

            const maxX = viewWidth - 1;
            const minX = -scaledWidth + 1;
            const maxY = viewHeight - 1;
            const minY = -scaledHeight + 1;

            viewOffset.x = Math.min(maxX, Math.max(viewOffset.x, minX));
            viewOffset.y = Math.min(maxY, Math.max(viewOffset.y, minY));
        },
        onZoom(e) {
            if (!this.hasOutput) return;
            e.preventDefault();

            const mouseX = e.offsetX;
            const mouseY = e.offsetY;

            const prevScale = viewScale;
            const delta = e.deltaY < 0 ? 1.1 : 0.9;
            viewScale = Math.min(5, Math.max(minViewScale, viewScale * delta));

            const scaleRatio = viewScale / prevScale;
            viewOffset.x = mouseX - (mouseX - viewOffset.x) * scaleRatio;
            viewOffset.y = mouseY - (mouseY - viewOffset.y) * scaleRatio;
            this.renderView();
        },
        startPan(e) {
            if (!this.hasOutput) return;
            if (e.button !== 0) return;
            isPanning = true;
            if (outputCanvas?.setPointerCapture) {
                outputCanvas.setPointerCapture(e.pointerId);
            }
            panStart = { x: e.offsetX - viewOffset.x, y: e.offsetY - viewOffset.y };
            outputCanvas.style.cursor = 'grabbing';
        },
        movePan(e) {
            if (!isPanning) return;
            viewOffset = { x: e.offsetX - panStart.x, y: e.offsetY - panStart.y };
            this.renderView();
        },
        endPan(e) {
            if (!isPanning) return;
            isPanning = false;
            if (outputCanvas?.releasePointerCapture) {
                try {
                    if (e?.pointerId !== undefined) {
                        outputCanvas.releasePointerCapture(e.pointerId);
                    }
                } catch {
                    // ignore if not captured
                }
            }
            if (outputCanvas) {
                outputCanvas.style.cursor = 'grab';
            }
        }
    };

    return state;
}

const app = createApp({ App }).mount('#app');

window.__opencvReady = async () => {
    if (window.__appState?.onOpenCvReady) {
        await window.__appState.onOpenCvReady();
    } else {
        window.__opencvPending = true;
    }
};
