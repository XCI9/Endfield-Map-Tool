// ─────────────────────────────────────────────
// Export Handler
// Preview canvas update, export to blob, download
// ─────────────────────────────────────────────

const EXPORT_SCAN_CHUNK_ROWS = 256;
const EXPORT_SCAN_PAINT_EVERY_CHUNKS = 4;

const ExportHandler = {
    async _findOpaqueBounds(appState, ctx, width, height) {
        let top = -1;
        let bottom = -1;
        let left = width;
        let right = -1;
        let chunkIndex = 0;

        for (let chunkY = 0; chunkY < height; chunkY += EXPORT_SCAN_CHUNK_ROWS) {
            const chunkHeight = Math.min(EXPORT_SCAN_CHUNK_ROWS, height - chunkY);
            const data = ctx.getImageData(0, chunkY, width, chunkHeight).data;

            for (let localY = 0; localY < chunkHeight; localY++) {
                const rowStart = localY * width;
                let firstX = -1;

                for (let x = 0; x < width; x++) {
                    if (data[(rowStart + x) * 4 + 3] > 0) {
                        firstX = x;
                        break;
                    }
                }

                if (firstX < 0) continue;

                const y = chunkY + localY;
                if (top < 0) top = y;
                bottom = y;

                let lastX = firstX;
                for (let x = width - 1; x >= firstX; x--) {
                    if (data[(rowStart + x) * 4 + 3] > 0) {
                        lastX = x;
                        break;
                    }
                }

                if (firstX < left) left = firstX;
                if (lastX > right) right = lastX;
            }

            chunkIndex++;
            const processedRows = chunkY + chunkHeight;
            appState.exportProgress = Math.round((processedRows / height) * 40);
            if (chunkIndex % EXPORT_SCAN_PAINT_EVERY_CHUNKS === 0 || processedRows === height) {
                await yieldToUI();
            }
        }

        return top < 0 ? null : {
            minX: left,
            minY: top,
            maxX: right,
            maxY: bottom,
        };
    },

    async updatePreview(appState) {
        if (!previewCanvas || !previewCtx) return;

        // 若 previewIncludeBase 與 showOriginalBase 一致，baseCanvas 已是目標狀態，可直接使用；
        // 否則需臨時重建（例如：顯示模式只看截圖，但匯出時要包含基底地圖）
        let sourceCanvas;
        if (appState.previewIncludeBase === appState.showOriginalBase &&
            CanvasManager.hasCanvasContent(baseCanvas)) {
            sourceCanvas = baseCanvas;
        } else {
            const dims = CanvasManager.getBaseDimensions();
            if (!dims) return;
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = dims.width;
            tempCanvas.height = dims.height;
            const tempCtx = tempCanvas.getContext('2d');
            if (appState.previewIncludeBase && CanvasManager.hasCanvasContent(originalBaseCanvas)) {
                tempCtx.drawImage(originalBaseCanvas, 0, 0);
            }
            for (const item of appState.history) {
                tempCtx.drawImage(
                    item.canvas,
                    0, 0, item.rect.width, item.rect.height,
                    item.rect.x, item.rect.y, item.rect.width, item.rect.height
                );
            }
            sourceCanvas = tempCanvas;
        }
        if (!sourceCanvas) return;

        if (appState.exportBlob) appState.exportBlob = null;
        appState.previewInfo = { width: 0, height: 0, size: '' };

        if (previewCropRect) {
            previewCanvas.width = previewCropRect.width;
            previewCanvas.height = previewCropRect.height;
            previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
            previewCtx.drawImage(sourceCanvas, previewCropRect.x, previewCropRect.y, previewCropRect.width, previewCropRect.height, 0, 0, previewCropRect.width, previewCropRect.height);
        } else {
            previewCanvas.width = sourceCanvas.width;
            previewCanvas.height = sourceCanvas.height;
            previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
            previewCtx.drawImage(sourceCanvas, 0, 0);
        }
    },

    openPreviewModal(appState) {
        if (appState.isProcessing || appState.isLoadingBaseMap) return;
        appState.showPreviewModal = true;
        this.updatePreview(appState);
    },

    closePreviewModal(appState) {
        appState.showPreviewModal = false;
    },

    async startExportProcess(appState) {
        if (appState.isExporting) return;
        const sourceCanvas = previewCanvas;
        if (!sourceCanvas) return;

        if (appState.exportBlob) appState.exportBlob = null;

        appState.isExporting = true;
        appState.exportProgress = 0;
        appState.exportProgressIndeterminate = false;
        appState.statusText = UIText.STATUS.EXPORT_PREPARING;
        await yieldToUI();

        let tempCanvas = null;
        try {
            const ctx = sourceCanvas.getContext('2d');
            const width = sourceCanvas.width;
            const height = sourceCanvas.height;
            let minX = 0;
            let minY = 0;
            let maxX = width - 1;
            let maxY = height - 1;

            if (appState.exportCropTransparent) {
                const bounds = await this._findOpaqueBounds(appState, ctx, width, height);
                if (!bounds) {
                    appState.statusText = UIText.STATUS.EXPORT_TRANSPARENT_IMAGE;
                    return;
                }
                ({ minX, minY, maxX, maxY } = bounds);
            } else {
                // 未裁透明邊界時不讀取任何 ImageData。
                appState.exportProgress = 40;
            }

            const finalW = maxX - minX + 1;
            const finalH = maxY - minY + 1;
            const needsCrop = minX !== 0 || minY !== 0 || finalW !== width || finalH !== height;

            appState.statusText = UIText.STATUS.EXPORT_CROPPING;
            await yieldToUI();

            let encodingCanvas = sourceCanvas;
            if (needsCrop) {
                tempCanvas = document.createElement('canvas');
                tempCanvas.width = finalW;
                tempCanvas.height = finalH;
                tempCanvas.getContext('2d').drawImage(
                    sourceCanvas,
                    minX, minY, finalW, finalH,
                    0, 0, finalW, finalH
                );
                encodingCanvas = tempCanvas;
            }

            appState.exportProgress = 50;
            appState.exportProgressIndeterminate = true;
            const formatName = appState.exportFormat === 'image/webp' ? 'WebP' : 'PNG';
            appState.statusText = UIText.STATUS.EXPORT_COMPRESSING(formatName);
            await yieldToUI();

            const blob = await new Promise((resolve) => {
                const quality = appState.exportFormat === 'image/webp' ? parseFloat(appState.exportQuality) : undefined;
                encodingCanvas.toBlob(resolve, appState.exportFormat, quality);
            });

            if (!blob) throw new Error('Blob creation failed');

            appState.exportProgressIndeterminate = false;
            appState.exportProgress = 100;
            appState.exportBlob = blob;

            const sizeKB = blob.size / 1024;
            const sizeMB = blob.size / (1024 * 1024);
            appState.previewInfo = {
                width: finalW,
                height: finalH,
                size: sizeMB >= 1 ? `${sizeMB.toFixed(2)} MB` : `${Math.round(sizeKB)} KB`
            };
            appState.statusText = UIText.STATUS.EXPORT_DONE;
        } catch (e) {
            appState.statusText = UIText.STATUS.EXPORT_FAILED(e.message);
        } finally {
            appState.exportProgressIndeterminate = false;
            appState.isExporting = false;
            if (tempCanvas) {
                tempCanvas.width = 1;
                tempCanvas.height = 1;
            }
        }
    },

    downloadExportedBlob(appState) {
        if (!appState.exportBlob) return;
        const url = URL.createObjectURL(appState.exportBlob);
        const ext = appState.exportFormat === 'image/webp' ? 'webp' : 'png';
        const link = document.createElement('a');
        link.download = `full_map_export_${Date.now()}.${ext}`;
        link.href = url;
        link.click();
        URL.revokeObjectURL(url);
        appState.showPreviewModal = false;
    }
};
