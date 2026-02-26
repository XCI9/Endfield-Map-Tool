// ─────────────────────────────────────────────
// Canvas & View Management
// Handles rendering, panning, zooming, overlay
// ─────────────────────────────────────────────

const CanvasManager = {
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
            if (overlayCanvas.width !== baseMat.cols || overlayCanvas.height !== baseMat.rows) {
                overlayCanvas.width = baseMat.cols;
                overlayCanvas.height = baseMat.rows;
            }
        }
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
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = finalSub.cols;
        tempCanvas.height = finalSub.rows;
        cv.imshow(tempCanvas, finalSub);
        overlayCtx.drawImage(tempCanvas, rect.x, rect.y, rect.width, rect.height);
        hasOverlay = true;
    },

    renderView(showOriginalBase) {
        const sourceCanvas = showOriginalBase ? baseCanvas : overlayCanvas;
        if (!outputCanvas || !sourceCanvas || !outputCtx) return;
        this.updateMinScale(showOriginalBase);
        this.clampViewOffset(showOriginalBase);
        outputCtx.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
        outputCtx.save();
        outputCtx.translate(viewOffset.x, viewOffset.y);
        outputCtx.scale(viewScale, viewScale);
        outputCtx.drawImage(sourceCanvas, 0, 0);
        outputCtx.restore();
    },

    updateMinScale(showOriginalBase) {
        const sourceCanvas = showOriginalBase ? baseCanvas : overlayCanvas;
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

    resetView(showOriginalBase) {
        this.updateMinScale(showOriginalBase);
        viewScale = minViewScale;
        viewOffset = { x: 0, y: 0 };
        this.renderView(showOriginalBase);
    },

    clampViewOffset(showOriginalBase) {
        const sourceCanvas = showOriginalBase ? baseCanvas : overlayCanvas;
        if (!outputCanvas || !sourceCanvas) return;
        const viewWidth = outputCanvas.width || outputCanvas.clientWidth;
        const viewHeight = outputCanvas.height || outputCanvas.clientHeight;
        const canvasWidth = sourceCanvas.width || sourceCanvas.clientWidth;
        const canvasHeight = sourceCanvas.height || sourceCanvas.clientHeight;
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

    startPan(e, hasOutput) {
        if (!hasOutput) return;
        if (e.button !== 0) return;
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
