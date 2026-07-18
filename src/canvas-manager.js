// ─────────────────────────────────────────────
// Canvas & View Management
// Handles rendering, panning, zooming, overlay
// ─────────────────────────────────────────────

const CanvasManager = {
    getBaseDimensions() {
        if (baseMapSize) {
            return { width: baseMapSize.width, height: baseMapSize.height };
        }
        if (isMatAvailable(baseAlphaMask)) {
            return { width: baseAlphaMask.cols, height: baseAlphaMask.rows };
        }
        if (this.hasCanvasContent(baseCanvas)) {
            return { width: baseCanvas.width, height: baseCanvas.height };
        }
        return null;
    },

    hasCanvasContent(canvas) {
        return !!(canvas && canvas.width > 0 && canvas.height > 0);
    },

    _getHistoryBounds(history) {
        const dims = this.getBaseDimensions();
        if (!dims || !history?.length) return null;

        let left = dims.width;
        let top = dims.height;
        let right = 0;
        let bottom = 0;

        for (const item of history) {
            const rect = item?.rect;
            if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y) ||
                !Number.isFinite(rect.width) || !Number.isFinite(rect.height) ||
                rect.width <= 0 || rect.height <= 0) {
                continue;
            }

            const itemLeft = Math.max(0, Math.floor(rect.x));
            const itemTop = Math.max(0, Math.floor(rect.y));
            const itemRight = Math.min(dims.width, Math.ceil(rect.x + rect.width));
            const itemBottom = Math.min(dims.height, Math.ceil(rect.y + rect.height));
            if (itemRight <= itemLeft || itemBottom <= itemTop) continue;

            left = Math.min(left, itemLeft);
            top = Math.min(top, itemTop);
            right = Math.max(right, itemRight);
            bottom = Math.max(bottom, itemBottom);
        }

        if (right <= left || bottom <= top) return null;
        return { x: left, y: top, width: right - left, height: bottom - top };
    },

    releaseHistoryCanvas() {
        historyCanvasBounds = null;
        if (!historyCanvas) return;
        historyCanvas.width = 1;
        historyCanvas.height = 1;
    },

    releaseBaseCanvas() {
        if (!baseCanvas) return;
        baseCanvas.width = 1;
        baseCanvas.height = 1;
    },

    // 將所有已確認圖片預先合成到其聯集矩形，而不是配置完整底圖大小的 Canvas。
    rebuildHistoryCanvas(appState) {
        if (!historyCanvas) return;
        const bounds = this._getHistoryBounds(appState.history);
        if (!bounds) {
            this.releaseHistoryCanvas();
            return;
        }

        if (historyCanvas.width !== bounds.width || historyCanvas.height !== bounds.height) {
            historyCanvas.width = bounds.width;
            historyCanvas.height = bounds.height;
        } else {
            historyCtx.clearRect(0, 0, historyCanvas.width, historyCanvas.height);
        }

        historyCanvasBounds = bounds;
        historyCtx.imageSmoothingEnabled = true;
        historyCtx.imageSmoothingQuality = 'high';
        for (const item of appState.history) {
            if (!item?.canvas || !item.rect) continue;
            historyCtx.drawImage(
                item.canvas,
                0, 0, item.rect.width, item.rect.height,
                item.rect.x - bounds.x, item.rect.y - bounds.y,
                item.rect.width, item.rect.height
            );
        }
    },

    syncBaseCanvasSize() {
        const dims = this.getBaseDimensions();
        if (!dims) return;
        if (baseCanvas) {
            if (baseCanvas.width !== dims.width || baseCanvas.height !== dims.height) {
                baseCanvas.width = dims.width;
                baseCanvas.height = dims.height;
            }
        }
    },

    drawMapLayers(ctx, includeBase) {
        if (!ctx) return;
        if (includeBase && this.hasCanvasContent(baseCanvas)) {
            ctx.drawImage(baseCanvas, 0, 0);
        }
        if (historyCanvasBounds && this.hasCanvasContent(historyCanvas)) {
            ctx.drawImage(historyCanvas, historyCanvasBounds.x, historyCanvasBounds.y);
        }
    },

    renderView(showOriginalBase) {
        const dims = this.getBaseDimensions();
        if (!outputCanvas || !dims || !outputCtx) return;
        this.updateMinScale(showOriginalBase);
        this.clampViewOffset(showOriginalBase);
        outputCtx.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
        outputCtx.save();
        outputCtx.translate(viewOffset.x, viewOffset.y);
        outputCtx.scale(viewScale, viewScale);
        this.drawMapLayers(outputCtx, showOriginalBase);
        outputCtx.restore();
        if (window.ManualPlacementHandler?.renderOverlay && window.__appState?.manualPlacementActive) {
            window.ManualPlacementHandler.renderOverlay(window.__appState);
        }
    },

    updateMinScale(showOriginalBase) {
        const dims = this.getBaseDimensions();
        if (!outputCanvas || !dims) return;
        const viewWidth = outputCanvas.width || outputCanvas.clientWidth;
        const viewHeight = outputCanvas.height || outputCanvas.clientHeight;
        const canvasWidth = dims.width;
        const canvasHeight = dims.height;
        if (!canvasWidth || !canvasHeight) return;
        const fitX = viewWidth / canvasWidth;
        const fitY = viewHeight / canvasHeight;
        minViewScale = Math.min(fitX, fitY);
        if (viewScale < minViewScale) {
            viewScale = minViewScale;
        }
    },

    resetView(showOriginalBase) {
        this.updateMinScale(showOriginalBase);
        viewScale = minViewScale;
        viewOffset = { x: 0, y: 0 };
        this.renderView(showOriginalBase);
    },

    clampViewOffset(showOriginalBase) {
        const dims = this.getBaseDimensions();
        if (!outputCanvas || !dims) return;
        const viewWidth = outputCanvas.width || outputCanvas.clientWidth;
        const viewHeight = outputCanvas.height || outputCanvas.clientHeight;
        const canvasWidth = dims.width;
        const canvasHeight = dims.height;
        if (!canvasWidth || !canvasHeight) return;

        const scaledWidth = canvasWidth * viewScale;
        const scaledHeight = canvasHeight * viewScale;

        viewOffset.x = Math.min(viewWidth - 1,  Math.max(viewOffset.x, -scaledWidth + 1));
        viewOffset.y = Math.min(viewHeight - 1, Math.max(viewOffset.y, -scaledHeight + 1));
    },

    resizeOutputCanvas(showOriginalBase) {
        if (!outputCanvas || !dropZoneEl) return;
        if (contentEl && toolbarEl) {
            const toolbarHeight = toolbarEl.getBoundingClientRect().height;
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            contentEl.style.width = `${Math.max(1, viewportWidth)}px`;
            contentEl.style.height = `${Math.max(1, viewportHeight - toolbarHeight)}px`;
        }
        const width = dropZoneEl.clientWidth || dropZoneEl.getBoundingClientRect().width;
        const height = dropZoneEl.clientHeight || dropZoneEl.getBoundingClientRect().height;
        const nextWidth = Math.max(1, Math.floor(width));
        const nextHeight = Math.max(1, Math.floor(height));
        outputCanvas.width = nextWidth;
        outputCanvas.height = nextHeight;
        outputCanvas.style.width = `${nextWidth}px`;
        outputCanvas.style.height = `${nextHeight}px`;
        this.updateMinScale(showOriginalBase);
        this.renderView(showOriginalBase);
    },

    onZoom(e, hasOutput, showOriginalBase) {
        if (!hasOutput) return;
        e.preventDefault();
        const mouseX = e.offsetX;
        const mouseY = e.offsetY;
        const prevScale = viewScale;
        const delta = e.deltaY < 0 ? 1.1 : 0.9;
        viewScale = Math.min(5, Math.max(minViewScale, viewScale * delta));
        const scaleRatio = viewScale / prevScale;
        viewOffset.x = mouseX - (mouseX - viewOffset.x) * scaleRatio;
        viewOffset.y = mouseY - (mouseY - viewOffset.y) * scaleRatio;
        this.renderView(showOriginalBase);
    },

    startPan(e, hasOutput, button = 0) {
        if (!hasOutput) return;
        if (e.button !== button) return;
        e.preventDefault();
        isPanning = true;
        if (outputCanvas?.setPointerCapture) {
            outputCanvas.setPointerCapture(e.pointerId);
        }
        panStart = { x: e.offsetX - viewOffset.x, y: e.offsetY - viewOffset.y };
        outputCanvas.style.cursor = 'grabbing';
    },

    movePan(e, showOriginalBase) {
        if (!isPanning) return;
        viewOffset = { x: e.offsetX - panStart.x, y: e.offsetY - panStart.y };
        this.renderView(showOriginalBase);
    },

    endPan(e) {
        if (!isPanning) return;
        isPanning = false;
        if (outputCanvas?.releasePointerCapture) {
            try {
                if (e?.pointerId !== undefined) {
                    outputCanvas.releasePointerCapture(e.pointerId);
                }
            } catch { /* ignore */ }
        }
        if (outputCanvas) outputCanvas.style.cursor = 'grab';
    }
};
