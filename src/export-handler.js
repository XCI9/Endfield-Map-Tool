// ─────────────────────────────────────────────
// Export Handler
// Preview canvas update, export to blob, download
// ─────────────────────────────────────────────

const ExportHandler = {
    async updatePreview(appState) {
        if (!previewCanvas || !previewCtx) return;
        const sourceCanvas = appState.previewIncludeBase ? baseCanvas : overlayCanvas;
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
        appState.statusText = '📦 準備匯出中...';
        await yieldToUI();

        const ctx = sourceCanvas.getContext('2d');
        const width = sourceCanvas.width;
        const height = sourceCanvas.height;
        const data = ctx.getImageData(0, 0, width, height).data;

        let minX = width, minY = height, maxX = 0, maxY = 0;
        let hasPixels = false;

        if (appState.exportCropTransparent) {
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    if (data[(y * width + x) * 4 + 3] > 0) {
                        if (x < minX) minX = x;
                        if (x > maxX) maxX = x;
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                        hasPixels = true;
                    }
                }
            }
            if (!hasPixels) {
                appState.statusText = '❌ 圖片全為透明，無法匯出';
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
        appState.statusText = '✂️ 正在裁切圖片...';
        await yieldToUI();

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = finalW;
        tempCanvas.height = finalH;
        tempCanvas.getContext('2d').drawImage(sourceCanvas, minX, minY, finalW, finalH, 0, 0, finalW, finalH);

        appState.exportProgress = 50;
        const formatName = appState.exportFormat === 'image/webp' ? 'WebP' : 'PNG';
        appState.statusText = `💾 正在壓縮圖片 (${formatName})...`;
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
            appState.statusText = '✅ 匯出完成，準備下載';
        } catch (e) {
            clearInterval(progressInterval);
            appState.statusText = '❌ 匯出失敗: ' + e.message;
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
    },

    downloadImage(appState) {
        const sourceCanvas = previewCanvas || baseCanvas;
        if (!sourceCanvas) return;

        const ctx = sourceCanvas.getContext('2d');
        const width = sourceCanvas.width;
        const height = sourceCanvas.height;
        const data = ctx.getImageData(0, 0, width, height).data;

        let minX = width, minY = height, maxX = 0, maxY = 0, hasPixels = false;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (data[(y * width + x) * 4 + 3] > 0) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                    hasPixels = true;
                }
            }
        }

        if (!hasPixels) { appState.statusText = '❌ 圖片全為透明，無法下載'; return; }

        const cropWidth = maxX - minX + 1;
        const cropHeight = maxY - minY + 1;
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = cropWidth;
        tempCanvas.height = cropHeight;
        tempCanvas.getContext('2d').drawImage(sourceCanvas, minX, minY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

        const link = document.createElement('a');
        link.download = 'full_map_updated.png';
        link.href = tempCanvas.toDataURL('image/png');
        link.click();
        appState.showPreviewModal = false;
    }
};
