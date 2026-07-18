// ─────────────────────────────────────────────
// Export Handler
// Preview canvas update, export to blob, download
// ─────────────────────────────────────────────

const EXPORT_SCAN_CHUNK_ROWS = 256;
const EXPORT_SCAN_PAINT_EVERY_CHUNKS = 4;

const ExportHandler = {
    _releaseCanvas(canvas) {
        if (!canvas) return;
        canvas.width = 1;
        canvas.height = 1;
    },

    releasePreviewResources(appState) {
        appState.exportBlob = null;
        appState.previewInfo = { width: 0, height: 0, size: '' };
        appState.exportProgress = 0;
        appState.exportProgressIndeterminate = false;
        appState.statusText = '';
        this._releaseCanvas(previewCanvas);
    },

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
        const dims = CanvasManager.getBaseDimensions();
        if (!dims) return;

        const sourceX = previewCropRect
            ? Math.max(0, Math.min(dims.width - 1, Math.floor(previewCropRect.x)))
            : 0;
        const sourceY = previewCropRect
            ? Math.max(0, Math.min(dims.height - 1, Math.floor(previewCropRect.y)))
            : 0;
        const sourceRight = previewCropRect
            ? Math.min(dims.width, Math.ceil(previewCropRect.x + previewCropRect.width))
            : dims.width;
        const sourceBottom = previewCropRect
            ? Math.min(dims.height, Math.ceil(previewCropRect.y + previewCropRect.height))
            : dims.height;
        const sourceWidth = sourceRight - sourceX;
        const sourceHeight = sourceBottom - sourceY;
        if (sourceWidth < 1 || sourceHeight < 1) return;

        if (appState.exportBlob) appState.exportBlob = null;
        appState.previewInfo = { width: 0, height: 0, size: '' };

        previewCanvas.width = sourceWidth;
        previewCanvas.height = sourceHeight;
        previewCtx.clearRect(0, 0, sourceWidth, sourceHeight);
        previewCtx.save();
        previewCtx.translate(-sourceX, -sourceY);
        CanvasManager.drawMapLayers(previewCtx, appState.previewIncludeBase);
        previewCtx.restore();
    },

    openPreviewModal(appState) {
        if (appState.isProcessing || appState.isLoadingBaseMap) return;
        appState.showPreviewModal = true;
        this.updatePreview(appState);
    },

    closePreviewModal(appState) {
        if (appState.isExporting) return;
        this.releasePreviewResources(appState);
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
            this._releaseCanvas(tempCanvas);
        }
    },

    downloadExportedBlob(appState) {
        if (!appState.exportBlob) return;
        const url = URL.createObjectURL(appState.exportBlob);
        const ext = appState.exportFormat === 'image/webp' ? 'webp' : 'png';
        const link = document.createElement('a');
        link.download = `full_map_export_${Date.now()}.${ext}`;
        link.href = url;
        try {
            link.click();
        } finally {
            // Give the browser one event-loop turn to start consuming the object URL.
            setTimeout(() => URL.revokeObjectURL(url), 0);
            this.closePreviewModal(appState);
        }
    }
};
