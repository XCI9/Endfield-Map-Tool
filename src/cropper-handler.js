// ─────────────────────────────────────────────
// Cropper Handler
// Manages Cropper.js lifecycle, file input,
// crop confirm for both input and preview modes
// ─────────────────────────────────────────────

const CropperHandler = {
    _cloneCanvas(sourceCanvas) {
        const cloned = document.createElement('canvas');
        cloned.width = sourceCanvas.width;
        cloned.height = sourceCanvas.height;
        cloned.getContext('2d').drawImage(sourceCanvas, 0, 0);
        return cloned;
    },

    _updateCropHistoryState(appState) {
        appState.cropCanUndo = !!(appState.cropEditUndoStack && appState.cropEditUndoStack.length > 0);
        appState.cropCanRedo = !!(appState.cropEditRedoStack && appState.cropEditRedoStack.length > 0);
    },

    _resetCropEditState(appState) {
        appState.cropEditMode = false;
        appState.cropCanUndo = false;
        appState.cropCanRedo = false;
        appState.cropEditUndoStack = [];
        appState.cropEditRedoStack = [];
        appState.cropEditIsDrawing = false;
        appState.cropEditSourceCanvas = null;
        appState.cropEditOriginalCanvas = null;
        appState.cropEditSavedCropData = null;
        appState.cropEditTransform = null;
        appState.cropEditLastPoint = null;
    },

    _hasManualCropEdits(appState) {
        return !!(
            appState.cropEditUndoStack?.length ||
            appState.cropEditRedoStack?.length
        );
    },

    _buildEnhanceBaseCanvas(appState) {
        if (!appState.cropInputOriginalCanvas) return null;
        if (!appState.enhanceMapBoundaryBrightness) {
            return this._cloneCanvas(appState.cropInputOriginalCanvas);
        }

        const fullRect = {
            x: 0,
            y: 0,
            width: appState.cropInputOriginalCanvas.width,
            height: appState.cropInputOriginalCanvas.height,
        };
        return BrightnessBoundaryEnhancer.applyToCroppedCanvas(appState.cropInputOriginalCanvas, fullRect)
            || this._cloneCanvas(appState.cropInputOriginalCanvas);
    },

    _pushCropUndoSnapshot(appState) {
        if (!appState.cropEditSourceCanvas) return;
        const ctx = appState.cropEditSourceCanvas.getContext('2d', { willReadFrequently: true });
        appState.cropEditUndoStack.push(ctx.getImageData(0, 0, appState.cropEditSourceCanvas.width, appState.cropEditSourceCanvas.height));
        if (appState.cropEditUndoStack.length > 20) appState.cropEditUndoStack.shift();
        appState.cropEditRedoStack = [];
        this._updateCropHistoryState(appState);
    },

    _getCropperOptions(cropModeValue) {
        if (cropModeValue === 'preview') {
            return {
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
            };
        }

        return {
            viewMode: 1,
            movable: true,
            zoomable: true,
            scalable: false,
            rotatable: false,
            restore: false,
            toggleDragModeOnDblclick: false,
        };
    },

    async _loadCropSourceCanvas(appState, sourceCanvas) {
        await this._replaceCropSourceCanvas(appState, sourceCanvas, {
            preserveCropBox: false,
            resetEditState: true,
        });
    },

    async _replaceCropSourceCanvas(appState, sourceCanvas, options = {}) {
        const preserveCropBox = !!options.preserveCropBox;
        const resetEditState = options.resetEditState !== false;
        let preservedCropData = null;

        if (preserveCropBox) {
            if (appState.cropper && typeof appState.cropper.getData === 'function') {
                preservedCropData = appState.cropper.getData(true);
            } else if (appState.cropEditSavedCropData) {
                preservedCropData = appState.cropEditSavedCropData;
            }
        }

        appState.cropEditSourceCanvas = this._cloneCanvas(sourceCanvas);
        appState.cropEditOriginalCanvas = this._cloneCanvas(sourceCanvas);

        if (resetEditState) {
            appState.cropEditUndoStack = [];
            appState.cropEditRedoStack = [];
            appState.cropEditSavedCropData = null;
            appState.cropEditIsDrawing = false;
            appState.cropEditTransform = null;
            appState.cropEditLastPoint = null;
            this._updateCropHistoryState(appState);
        }

        await this._rebuildCropperFromSource(appState, preservedCropData);
    },

    async _rebuildCropperFromSource(appState, preservedCropData = null) {
        if (!appState.cropEditSourceCanvas) return;

        const image = document.getElementById('cropImage');
        if (!image) return;

        appState.cropEditMode = false;
        image.src = appState.cropEditSourceCanvas.toDataURL('image/png');

        await new Promise((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = reject;
        });

        if (appState.cropper) {
            appState.cropper.destroy();
            appState.cropper = null;
        }

        await new Promise((resolve) => {
            const options = this._getCropperOptions(cropMode);
            const originalReady = options.ready;
            options.ready = () => {
                if (typeof originalReady === 'function') originalReady();
                if (preservedCropData) appState.cropper.setData(preservedCropData);
                resolve();
            };
            appState.cropper = new Cropper(image, options);
        });
    },

    _getCropEditPoint(appState, event) {
        if (!appState.cropEditMode || !appState.cropEditTransform) return null;
        const canvas = document.getElementById('cropEditCanvas');
        if (!canvas) return null;

        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        const { scale, offsetX, offsetY, width, height } = appState.cropEditTransform;
        const sourceX = (x - offsetX) / scale;
        const sourceY = (y - offsetY) / scale;

        if (sourceX < 0 || sourceY < 0 || sourceX > width || sourceY > height) return null;
        return { x: sourceX, y: sourceY };
    },

    _eraseAtPoint(appState, fromPoint, toPoint) {
        if (!appState.cropEditSourceCanvas) return;
        const ctx = appState.cropEditSourceCanvas.getContext('2d');
        const scale = appState.cropEditTransform?.scale || 1;
        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(0,0,0,1)';
        ctx.fillStyle = 'rgba(0,0,0,1)';
        ctx.lineWidth = Math.max(1, appState.cropBrushSize / scale);

        if (fromPoint && toPoint) {
            ctx.beginPath();
            ctx.moveTo(fromPoint.x, fromPoint.y);
            ctx.lineTo(toPoint.x, toPoint.y);
            ctx.stroke();
        }

        const targetPoint = toPoint || fromPoint;
        if (targetPoint) {
            ctx.beginPath();
            ctx.arc(targetPoint.x, targetPoint.y, ctx.lineWidth / 2, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    },

    _drawCheckerboard(ctx, x, y, width, height, appState) {
        if (!this._bgImage) {
            this._bgImage = new Image();
            this._bgImage.onload = () => {
                this._checkerPattern = null;
                if (appState && appState.cropEditMode) {
                    this.renderCropEditCanvas(appState);
                }
            };
            this._bgImage.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQAQMAAAAlPW0iAAAAA3NCSVQICAjb4U/gAAAABlBMVEXMzMz////TjRV2AAAACXBIWXMAAArrAAAK6wGCiw1aAAAAHHRFWHRTb2Z0d2FyZQBBZG9iZSBGaXJld29ya3MgQ1M26LyyjAAAABFJREFUCJlj+M/AgBVhF/0PAH6/D/HkDxOGAAAAAElFTkSuQmCC';
        }

        if (this._bgImage.complete && this._bgImage.width > 0) {
            if (!this._checkerPattern) {
                this._checkerPattern = ctx.createPattern(this._bgImage, 'repeat');
            }
            ctx.save();
            ctx.translate(x, y);
            ctx.fillStyle = this._checkerPattern;
            ctx.fillRect(0, 0, width, height);
            
            // 加入一層半透明黑色遮罩，使其與外部裁剪顯示更接近
            ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
            ctx.fillRect(0, 0, width, height);
            
            ctx.restore();
        } else {
            ctx.save();
            ctx.fillStyle = '#eee';
            ctx.fillRect(x, y, width, height);
            ctx.restore();
        }
    },

    updateCropEditCursor(appState) {
        const canvas = document.getElementById('cropEditCanvas');
        if (!canvas) return;

        if (!appState.cropEditMode) {
            canvas.style.cursor = 'default';
            return;
        }

        const brushSize = Math.max(8, Number(appState.cropBrushSize) || 36);
        const cursorSize = Math.min(128, Math.max(24, Math.ceil(brushSize + 10)));
        const radius = Math.max(2, brushSize / 2);
        const center = cursorSize / 2;
        const svg = `
            <svg xmlns="http://www.w3.org/2000/svg" width="${cursorSize}" height="${cursorSize}" viewBox="0 0 ${cursorSize} ${cursorSize}">
                <circle cx="${center}" cy="${center}" r="${radius}" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.95)" stroke-width="1.5"/>
                <circle cx="${center}" cy="${center}" r="1.5" fill="rgba(255,255,255,0.95)"/>
            </svg>`;
        canvas.style.cursor = `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") ${center} ${center}, crosshair`;
    },

    renderCropEditCanvas(appState) {
        if (!appState.cropEditMode || !appState.cropEditSourceCanvas) return;

        const canvas = document.getElementById('cropEditCanvas');
        const wrapper = document.querySelector('.crop-wrapper');
        if (!canvas || !wrapper) return;

        const width = Math.max(1, Math.floor(wrapper.clientWidth || appState.cropEditSourceCanvas.width));
        const height = Math.max(1, Math.floor(wrapper.clientHeight || appState.cropEditSourceCanvas.height));
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;

        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = '#111';
        ctx.fillRect(0, 0, width, height);

        const scale = Math.min(width / appState.cropEditSourceCanvas.width, height / appState.cropEditSourceCanvas.height);
        const drawWidth = appState.cropEditSourceCanvas.width * scale;
        const drawHeight = appState.cropEditSourceCanvas.height * scale;
        const offsetX = (width - drawWidth) / 2;
        const offsetY = (height - drawHeight) / 2;

        appState.cropEditTransform = {
            scale,
            offsetX,
            offsetY,
            width: appState.cropEditSourceCanvas.width,
            height: appState.cropEditSourceCanvas.height
        };

        this._drawCheckerboard(ctx, offsetX, offsetY, drawWidth, drawHeight, appState);
        ctx.drawImage(appState.cropEditSourceCanvas, offsetX, offsetY, drawWidth, drawHeight);
        this.updateCropEditCursor(appState);
    },

    openFilePicker(appState) {
        if (appState.isProcessing || appState.isLoadingBaseMap) return;
        appState.$refs.subFile.value = '';
        appState.$refs.subFile.click();
    },

    onSubFileChange(appState, e) {
        const file = e.target.files?.[0];
        if (file) this.openCropWithFile(appState, file);
    },

    async openCropWithFile(appState, file) {
        if (appState.isProcessing || appState.isLoadingBaseMap) return;
        if (!file.type.startsWith('image/')) {
            appState.statusText = '❌ 只支援圖片檔案';
            return;
        }

        cropMode = 'input';
        appState.showBrightnessEnhanceOption = true;
        currentFileCallback = (canvas) => Matcher.processScreenshotAfterCrop(appState, canvas);

        const imgObj = new Image();
        const url = URL.createObjectURL(file);
        
        await new Promise((resolve, reject) => {
            imgObj.onload = () => {
                URL.revokeObjectURL(url);
                resolve();
            };
            imgObj.onerror = reject;
            imgObj.src = url;
        });

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = imgObj.width;
        tempCanvas.height = imgObj.height;
        const ctx = tempCanvas.getContext('2d');
        ctx.drawImage(imgObj, 0, 0);

        const width = tempCanvas.width;
        const height = tempCanvas.height;
        const data = ctx.getImageData(0, 0, width, height).data;

        let minX = width, minY = height, maxX = 0, maxY = 0;
        let hasPixels = false;
        let opaquePixelCount = 0;

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (data[(y * width + x) * 4 + 3] > 0) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                    hasPixels = true;
                    opaquePixelCount++;
                }
            }
        }

        let finalCanvas = tempCanvas;
        let finalW = width;
        let finalH = height;

        // 如果有透明邊界需要裁切
        if (hasPixels && (minX > 0 || minY > 0 || maxX < width - 1 || maxY < height - 1)) {
            finalW = maxX - minX + 1;
            finalH = maxY - minY + 1;
            const cropCanvas = document.createElement('canvas');
            cropCanvas.width = finalW;
            cropCanvas.height = finalH;
            cropCanvas.getContext('2d').drawImage(tempCanvas, minX, minY, finalW, finalH, 0, 0, finalW, finalH);
            finalCanvas = cropCanvas;
        }

        // 計算裁切後的透明區域比例
        const totalPixels = finalW * finalH;
        const transparentRatio = (totalPixels - opaquePixelCount) / totalPixels;

        appState.showCrop = true;
        if (transparentRatio > 0.4) {
             appState.cropStatus = `⚠️ 圖片透明區域達 ${(transparentRatio * 100).toFixed(0)}%，可能影響辨識！請盡量保留更多實體地圖畫面，或裁切掉透明區域。`;
        } else {
             appState.cropStatus = '請調整裁剪區域';
        }

        appState.cropInputOriginalCanvas = this._cloneCanvas(finalCanvas);
        const sourceCanvas = this._buildEnhanceBaseCanvas(appState) || finalCanvas;

        await yieldToUI();
        await this._loadCropSourceCanvas(appState, sourceCanvas);
    },

    resetCrop(appState) {
        if (appState.cropEditMode) {
            if (!appState.cropEditOriginalCanvas) return;
            appState.cropEditSourceCanvas = this._cloneCanvas(appState.cropEditOriginalCanvas);
            appState.cropEditUndoStack = [];
            appState.cropEditRedoStack = [];
            this._updateCropHistoryState(appState);
            appState.cropStatus = '橡皮擦模式：在圖片上拖曳即可擦除。';
            this.renderCropEditCanvas(appState);
            return;
        }
        if (appState.cropper) appState.cropper.reset();
    },

    selectAllCrop(appState) {
        if (appState.cropEditMode) return;
        if (appState.cropper) {
            const data = appState.cropper.getImageData();
            appState.cropper.setData({ x: 0, y: 0, width: data.naturalWidth, height: data.naturalHeight });
        }
    },

    async toggleCropEditMode(appState) {
        if (!appState.showCrop || !appState.cropEditSourceCanvas) return;

        if (!appState.cropEditMode) {
            appState.cropEditSavedCropData = appState.cropper ? appState.cropper.getData(true) : null;
            if (appState.cropper) {
                appState.cropper.destroy();
                appState.cropper = null;
            }
            appState.cropEditMode = true;
            appState.cropStatus = '橡皮擦模式：在圖片上拖曳即可擦除。';
            await yieldToUI();
            this.renderCropEditCanvas(appState);
            return;
        }

        appState.cropEditMode = false;
        appState.cropStatus = '請調整裁剪區域';
        this.updateCropEditCursor(appState);
        await yieldToUI();
        await this._rebuildCropperFromSource(appState, appState.cropEditSavedCropData);
    },

    undoCropEdit(appState) {
        if (!appState.cropEditMode || !appState.cropEditSourceCanvas || !appState.cropEditUndoStack?.length) return;
        const ctx = appState.cropEditSourceCanvas.getContext('2d', { willReadFrequently: true });
        appState.cropEditRedoStack.push(ctx.getImageData(0, 0, appState.cropEditSourceCanvas.width, appState.cropEditSourceCanvas.height));
        const previous = appState.cropEditUndoStack.pop();
        ctx.putImageData(previous, 0, 0);
        this._updateCropHistoryState(appState);
        this.renderCropEditCanvas(appState);
    },

    redoCropEdit(appState) {
        if (!appState.cropEditMode || !appState.cropEditSourceCanvas || !appState.cropEditRedoStack?.length) return;
        const ctx = appState.cropEditSourceCanvas.getContext('2d', { willReadFrequently: true });
        appState.cropEditUndoStack.push(ctx.getImageData(0, 0, appState.cropEditSourceCanvas.width, appState.cropEditSourceCanvas.height));
        const next = appState.cropEditRedoStack.pop();
        ctx.putImageData(next, 0, 0);
        this._updateCropHistoryState(appState);
        this.renderCropEditCanvas(appState);
    },

    startCropErase(appState, event) {
        if (!appState.cropEditMode) return;
        const canvas = document.getElementById('cropEditCanvas');
        if (!canvas) return;

        const point = this._getCropEditPoint(appState, event);
        if (!point) return;

        event.preventDefault();
        this._pushCropUndoSnapshot(appState);
        appState.cropEditIsDrawing = true;
        appState.cropEditLastPoint = point;
        canvas.setPointerCapture?.(event.pointerId);
        this._eraseAtPoint(appState, point, point);
        this.renderCropEditCanvas(appState);
    },

    moveCropErase(appState, event) {
        if (!appState.cropEditMode || !appState.cropEditIsDrawing) return;
        const point = this._getCropEditPoint(appState, event);
        if (!point) return;

        event.preventDefault();
        this._eraseAtPoint(appState, appState.cropEditLastPoint, point);
        appState.cropEditLastPoint = point;
        this.renderCropEditCanvas(appState);
    },

    endCropErase(appState) {
        if (!appState.cropEditMode) return;
        appState.cropEditIsDrawing = false;
        appState.cropEditLastPoint = null;
    },

    // 用現有 canvas 直接開啟裁劉介面（重新調整上一張截圖用）
    async openCropWithCanvas(appState, canvas) {
        if (appState.isProcessing || appState.isLoadingBaseMap) return;

        cropMode = 'input';
        appState.showBrightnessEnhanceOption = true;
        currentFileCallback = (croppedCanvas) => Matcher.processScreenshotAfterCrop(appState, croppedCanvas);

        // 計算透明區域比例，供狀態提示
        const width = canvas.width;
        const height = canvas.height;
        const data = canvas.getContext('2d', { willReadFrequently: true })
            .getImageData(0, 0, width, height).data;
        let opaqueCount = 0;
        for (let i = 3; i < data.length; i += 4) {
            if (data[i] > 0) opaqueCount++;
        }
        const transparentRatio = (width * height - opaqueCount) / (width * height);

        appState.showCrop = true;
        appState.cropStatus = transparentRatio > 0.4
            ? `⚠️ 圖片透明區域達 ${(transparentRatio * 100).toFixed(0)}%，可能影響辨識！請裁掉透明區域。`
            : '請調整裁剪區域';

        appState.cropInputOriginalCanvas = this._cloneCanvas(canvas);
        const sourceCanvas = this._buildEnhanceBaseCanvas(appState) || canvas;

        await yieldToUI();
        await this._loadCropSourceCanvas(appState, sourceCanvas);
    },

    async onEnhanceBoundaryToggle(appState, event) {
        const enabled = !!event?.target?.checked;
        appState.enhanceMapBoundaryBrightness = enabled;

        if (!appState.showCrop || cropMode !== 'input') return;
        if (!appState.cropInputOriginalCanvas) return;

        let shouldResetState = false;
        if (this._hasManualCropEdits(appState)) {
            const actionText = enabled ? '開啟' : '關閉';
            const confirmed = await appState.openConfirmModal(
                `確認${actionText}功能？`,
                `${actionText}此功能會重置所有編輯狀態，是否繼續`,
                `確認${actionText}`,
                '取消'
            );
            if (!confirmed) {
                const rollback = !enabled;
                appState.enhanceMapBoundaryBrightness = rollback;
                if (event?.target) event.target.checked = rollback;
                return;
            }
            shouldResetState = true;
        }

        const sourceCanvas = this._buildEnhanceBaseCanvas(appState);
        if (!sourceCanvas) return;
        await this._replaceCropSourceCanvas(appState, sourceCanvas, {
            preserveCropBox: !shouldResetState,
            resetEditState: shouldResetState,
        });
        appState.cropStatus = enabled
            ? '已套用邊界亮度提升。'
            : (shouldResetState ? '已關閉邊界亮度提升，編輯狀態已重置。' : '已關閉邊界亮度提升。');
    },

    cancelCrop(appState) {
        appState.showCrop = false;
        appState.showBrightnessEnhanceOption = false;
        appState.cropInputOriginalCanvas = null;
        if (appState.cropper) {
            appState.cropper.destroy();
            appState.cropper = null;
        }
        this._resetCropEditState(appState);
        appState.cropStatus = '請拖拽選擇要裁剪的區域';
    },

    async confirmCrop(appState) {
        if (appState.cropEditMode) {
            await this.toggleCropEditMode(appState);
        }
        if (!appState.cropper) return;

        const cropData = appState.cropper.getData(true);
        const cropRect = {
            x: Math.round(cropData.x),
            y: Math.round(cropData.y),
            width: Math.round(cropData.width),
            height: Math.round(cropData.height)
        };

        const croppedCanvas = appState.cropper.getCroppedCanvas();
        if (!croppedCanvas || croppedCanvas.width < 1 || croppedCanvas.height < 1) {
            appState.cropStatus = '裁剪區域過小，請重新選擇。';
            return;
        }

        if (cropMode === 'preview') {
            previewCropRect = cropRect;
            appState.showCrop = false;
            appState.showBrightnessEnhanceOption = false;
            appState.cropInputOriginalCanvas = null;
            if (appState.cropper) { appState.cropper.destroy(); appState.cropper = null; }
            this._resetCropEditState(appState);
            appState.cropStatus = '請拖拽選擇要裁剪的區域';
            ExportHandler.updatePreview(appState);
            return;
        }

        // Preserve pre-crop source canvas before reset so enhancement can use
        // the original coordinate system (pre-crop) as intended.
        const sourceCanvasForEnhance = appState.cropEditSourceCanvas;

        appState.showCrop = false;
        appState.showBrightnessEnhanceOption = false;
        appState.cropInputOriginalCanvas = null;
        if (appState.cropper) { appState.cropper.destroy(); appState.cropper = null; }
        this._resetCropEditState(appState);
        appState.cropStatus = '請拖拽選擇要裁剪的區域';

        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
        await new Promise((resolve) => setTimeout(resolve, 0));

        let finalCanvas = croppedCanvas;
        if (appState.enhanceMapBoundaryBrightness && cropMode === 'input' && sourceCanvasForEnhance) {
            const enhancedCanvas = BrightnessBoundaryEnhancer.applyToCroppedCanvas(sourceCanvasForEnhance, cropRect);
            if (enhancedCanvas) finalCanvas = enhancedCanvas;
        }

        if (currentFileCallback) await currentFileCallback(finalCanvas);
    },

    async openPreviewCrop(appState) {
        if (!previewCanvas) return;
        if (appState.exportBlob) {
            appState.exportBlob = null;
            appState.previewInfo = { width: 0, height: 0, size: '' };
        }
        cropMode = 'preview';
        appState.showBrightnessEnhanceOption = false;

        appState.showCrop = true;
        appState.cropStatus = '請拖拽選擇要裁剪的區域';
        await yieldToUI();
        await this._loadCropSourceCanvas(appState, previewCanvas);
    },

    clearPreviewCrop(appState) {
        previewCropRect = null;
        ExportHandler.updatePreview(appState);
    }
};
