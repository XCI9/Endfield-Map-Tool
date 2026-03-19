// ─────────────────────────────────────────────
// Export Handler
// Preview canvas update, export to blob, download
// ─────────────────────────────────────────────

const ExportHandler = {
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

        if (appState.exportBlob) { URL.revokeObjectURL(appState.exportBlob); appState.exportBlob = null; }

        appState.isExporting = true;
        appState.exportProgress = 0;
        appState.statusText = UIText.STATUS.EXPORT_PREPARING;
        await yieldToUI();

        const ctx = sourceCanvas.getContext('2d');
        const width = sourceCanvas.width;
        const height = sourceCanvas.height;
        const data = ctx.getImageData(0, 0, width, height).data;

        let minX = width, minY = height, maxX = 0, maxY = 0;
        let hasPixels = false;

        if (appState.exportCropTransparent) {
            let top = -1, bottom = -1, left = width, right = -1;

            // Highly optimized bounding box search skipping inner transparent pixels
            for (let y = 0; y < height; y++) {
                const rowStart = y * width;
                let foundInRow = false;
                let firstX = -1, lastX = -1;

                // Find left-most pixel in this row
                for (let x = 0; x < width; x++) {
                    if (data[(rowStart + x) * 4 + 3] > 0) {
                        firstX = x;
                        foundInRow = true;
                        break;
                    }
                }

                if (foundInRow) {
                    if (top === -1) top = y;
                    bottom = y;

                    // Find right-most pixel in this row
                    for (let x = width - 1; x >= firstX; x--) {
                        if (data[(rowStart + x) * 4 + 3] > 0) {
                            lastX = x;
                            break;
                        }
                    }

                    if (firstX < left) left = firstX;
                    if (lastX > right) right = lastX;
                }
            }

            if (top !== -1) {
                minX = left; maxX = right; minY = top; maxY = bottom;
                hasPixels = true;
            }

            if (!hasPixels) {
                appState.statusText = UIText.STATUS.EXPORT_TRANSPARENT_IMAGE;
                appState.isExporting = false;
                return;
            }
        } else {
            minX = 0; minY = 0; maxX = width - 1; maxY = height - 1;
            hasPixels = true;
        }

        const finalW = maxX - minX + 1;
        const finalH = maxY - minY + 1;

        appState.exportProgress = 30;
    appState.statusText = UIText.STATUS.EXPORT_CROPPING;
        await yieldToUI();

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = finalW;
        tempCanvas.height = finalH;
        tempCanvas.getContext('2d').drawImage(sourceCanvas, minX, minY, finalW, finalH, 0, 0, finalW, finalH);

        appState.exportProgress = 50;
        const formatName = appState.exportFormat === 'image/webp' ? 'WebP' : 'PNG';
    appState.statusText = UIText.STATUS.EXPORT_COMPRESSING(formatName);
        await yieldToUI();

        const progressInterval = setInterval(() => {
            if (appState.exportProgress < 99) {
                appState.exportProgress = parseFloat(Math.min(99, appState.exportProgress + Math.random()).toFixed(2));
            }
        }, 100);

        try {
            const blob = await new Promise((resolve) => {
                const quality = appState.exportFormat === 'image/webp' ? parseFloat(appState.exportQuality) : undefined;
                tempCanvas.toBlob(resolve, appState.exportFormat, quality);
            });

            clearInterval(progressInterval);
            if (!blob) throw new Error('Blob creation failed');

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
            clearInterval(progressInterval);
            appState.statusText = UIText.STATUS.EXPORT_FAILED(e.message);
        } finally {
            appState.isExporting = false;
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
