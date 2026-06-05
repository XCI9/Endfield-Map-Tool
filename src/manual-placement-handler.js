// Manual screenshot placement on the main map canvas.

const ManualPlacementHandler = {
    HANDLE_SIZE: 10,
    MIN_SIZE: 16,

    _cloneCanvas(sourceCanvas) {
        const cloned = document.createElement('canvas');
        cloned.width = sourceCanvas.width;
        cloned.height = sourceCanvas.height;
        cloned.getContext('2d').drawImage(sourceCanvas, 0, 0);
        return cloned;
    },

    _screenToMap(event) {
        return {
            x: (event.offsetX - viewOffset.x) / viewScale,
            y: (event.offsetY - viewOffset.y) / viewScale,
        };
    },

    _getVisibleMapCenter() {
        if (!outputCanvas) return null;
        return {
            x: ((outputCanvas.width || outputCanvas.clientWidth) / 2 - viewOffset.x) / viewScale,
            y: ((outputCanvas.height || outputCanvas.clientHeight) / 2 - viewOffset.y) / viewScale,
        };
    },

    _clampRectToMap(rect) {
        const dims = CanvasManager.getBaseDimensions();
        if (!dims) return rect;
        const width = Math.min(Math.max(this.MIN_SIZE, rect.width), dims.width);
        const height = Math.min(Math.max(this.MIN_SIZE, rect.height), dims.height);
        return {
            x: Math.min(Math.max(0, rect.x), Math.max(0, dims.width - width)),
            y: Math.min(Math.max(0, rect.y), Math.max(0, dims.height - height)),
            width,
            height,
        };
    },

    _buildInitialRect(canvas) {
        const dims = CanvasManager.getBaseDimensions();
        const aspect = canvas.width / canvas.height || 1;
        const maxWidth = dims ? dims.width * 0.35 : canvas.width;
        const maxHeight = dims ? dims.height * 0.35 : canvas.height;
        const scale = Math.min(1, maxWidth / canvas.width, maxHeight / canvas.height);
        const width = Math.max(this.MIN_SIZE, Math.round(canvas.width * scale));
        const height = Math.max(this.MIN_SIZE, Math.round(width / aspect));
        const center = this._getVisibleMapCenter() || {
            x: dims ? dims.width / 2 : width / 2,
            y: dims ? dims.height / 2 : height / 2,
        };

        return this._clampRectToMap({
            x: Math.round(center.x - width / 2),
            y: Math.round(center.y - height / 2),
            width,
            height,
        });
    },

    start(appState, canvas) {
        if (!canvas || !CanvasManager.getBaseDimensions()) {
            appState.statusText = UIText.STATUS.BASE_MAP_NOT_LOADED;
            return;
        }

        const sourceCanvas = this._cloneCanvas(canvas);
        appState.manualPlacementActive = true;
        appState.manualPlacement = {
            canvas: sourceCanvas,
            rect: this._buildInitialRect(sourceCanvas),
            aspect: sourceCanvas.width / sourceCanvas.height || 1,
            dragMode: null,
            pointerId: null,
            startPoint: null,
            startRect: null,
        };
        appState.hasOutput = true;
        appState.statusText = UIText.STATUS.MANUAL_PLACEMENT_READY;
        CanvasManager.renderView(appState.showOriginalBase);
    },

    cancel(appState) {
        appState.manualPlacementActive = false;
        appState.manualPlacement = null;
        CanvasManager.renderView(appState.showOriginalBase);
        appState.statusText = UIText.STATUS.MANUAL_PLACEMENT_CANCELLED;
    },

    confirm(appState) {
        const placement = appState.manualPlacement;
        if (!placement?.canvas || !placement.rect) return;

        const rect = this._clampRectToMap({
            x: Math.round(placement.rect.x),
            y: Math.round(placement.rect.y),
            width: Math.round(placement.rect.width),
            height: Math.round(placement.rect.height),
        });

        if (rect.width < 1 || rect.height < 1) return;

        const resizedCanvas = document.createElement('canvas');
        resizedCanvas.width = rect.width;
        resizedCanvas.height = rect.height;
        const ctx = resizedCanvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(placement.canvas, 0, 0, placement.canvas.width, placement.canvas.height, 0, 0, rect.width, rect.height);

        appState.manualPlacementActive = false;
        appState.manualPlacement = null;
        History.addRecord(appState, placement.canvas, resizedCanvas, rect, rect.width / placement.canvas.width, appState.enhanceMapBoundaryBrightness);
        appState.hasOutput = true;
        CanvasManager.resetView(appState.showOriginalBase);
        appState.statusText = UIText.STATUS.MANUAL_PLACEMENT_ADDED;
    },

    _getHitTarget(appState, event) {
        const placement = appState.manualPlacement;
        if (!placement?.rect) return null;

        const rect = placement.rect;
        const point = this._screenToMap(event);
        const handlePadding = this.HANDLE_SIZE / Math.max(viewScale, 0.001);
        const handles = this._getHandles(rect);

        for (const handle of handles) {
            if (Math.abs(point.x - handle.x) <= handlePadding && Math.abs(point.y - handle.y) <= handlePadding) {
                return { mode: handle.name, point };
            }
        }

        if (point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height) {
            return { mode: 'move', point };
        }

        return null;
    },

    _getHandles(rect) {
        const midX = rect.x + rect.width / 2;
        const midY = rect.y + rect.height / 2;
        return [
            { name: 'nw', x: rect.x, y: rect.y },
            { name: 'n', x: midX, y: rect.y },
            { name: 'ne', x: rect.x + rect.width, y: rect.y },
            { name: 'e', x: rect.x + rect.width, y: midY },
            { name: 'se', x: rect.x + rect.width, y: rect.y + rect.height },
            { name: 's', x: midX, y: rect.y + rect.height },
            { name: 'sw', x: rect.x, y: rect.y + rect.height },
            { name: 'w', x: rect.x, y: midY },
        ];
    },

    _resizeFromHandle(appState, point) {
        const placement = appState.manualPlacement;
        const startRect = placement.startRect;
        const mode = placement.dragMode;
        const aspect = placement.aspect || 1;

        if (mode === 'e' || mode === 'w') {
            const anchorX = mode === 'w' ? startRect.x + startRect.width : startRect.x;
            const centerY = startRect.y + startRect.height / 2;
            const signX = mode === 'w' ? -1 : 1;
            const width = Math.max(this.MIN_SIZE, Math.abs(point.x - anchorX));
            const height = Math.max(this.MIN_SIZE, width / aspect);
            placement.rect = this._clampRectToMap({
                x: signX < 0 ? anchorX - width : anchorX,
                y: centerY - height / 2,
                width,
                height,
            });
            return;
        }

        if (mode === 'n' || mode === 's') {
            const anchorY = mode === 'n' ? startRect.y + startRect.height : startRect.y;
            const centerX = startRect.x + startRect.width / 2;
            const signY = mode === 'n' ? -1 : 1;
            const height = Math.max(this.MIN_SIZE, Math.abs(point.y - anchorY));
            const width = Math.max(this.MIN_SIZE, height * aspect);
            placement.rect = this._clampRectToMap({
                x: centerX - width / 2,
                y: signY < 0 ? anchorY - height : anchorY,
                width,
                height,
            });
            return;
        }

        const anchorX = mode.includes('w') ? startRect.x + startRect.width : startRect.x;
        const anchorY = mode.includes('n') ? startRect.y + startRect.height : startRect.y;
        const signX = mode.includes('w') ? -1 : 1;
        const signY = mode.includes('n') ? -1 : 1;
        let width = Math.abs(point.x - anchorX);
        let height = Math.abs(point.y - anchorY);
        if (width / aspect > height) height = width / aspect;
        else width = height * aspect;
        width = Math.max(this.MIN_SIZE, width);
        height = Math.max(this.MIN_SIZE, height);

        placement.rect = this._clampRectToMap({
            x: signX < 0 ? anchorX - width : anchorX,
            y: signY < 0 ? anchorY - height : anchorY,
            width,
            height,
        });
    },

    handlePointerDown(appState, event) {
        if (!appState.manualPlacementActive) return false;
        if (event.button === 1) return false;
        const hit = this._getHitTarget(appState, event);
        if (!hit) return false;

        event.preventDefault();
        const placement = appState.manualPlacement;
        placement.dragMode = hit.mode;
        placement.pointerId = event.pointerId;
        placement.startPoint = hit.point;
        placement.startRect = { ...placement.rect };
        outputCanvas?.setPointerCapture?.(event.pointerId);
        this.updateCursor(appState, event);
        return true;
    },

    handlePointerMove(appState, event) {
        if (!appState.manualPlacementActive) return false;
        if (isPanning) return false;
        const placement = appState.manualPlacement;

        if (!placement?.dragMode) {
            this.updateCursor(appState, event);
            return true;
        }

        event.preventDefault();
        const point = this._screenToMap(event);

        if (placement.dragMode === 'move') {
            placement.rect = this._clampRectToMap({
                x: placement.startRect.x + point.x - placement.startPoint.x,
                y: placement.startRect.y + point.y - placement.startPoint.y,
                width: placement.startRect.width,
                height: placement.startRect.height,
            });
        } else {
            this._resizeFromHandle(appState, point);
        }

        CanvasManager.renderView(appState.showOriginalBase);
        return true;
    },

    handlePointerUp(appState, event) {
        if (!appState.manualPlacementActive) return false;
        if (isPanning) return false;
        const placement = appState.manualPlacement;
        if (placement) {
            placement.dragMode = null;
            placement.pointerId = null;
            placement.startPoint = null;
            placement.startRect = null;
        }
        try {
            if (event?.pointerId !== undefined) outputCanvas?.releasePointerCapture?.(event.pointerId);
        } catch (_error) {
            // Ignore stale pointer capture releases.
        }
        this.updateCursor(appState, event);
        return true;
    },

    updateCursor(appState, event) {
        if (!outputCanvas || !appState.manualPlacementActive) return;
        const activeMode = appState.manualPlacement?.dragMode;
        const hit = event ? this._getHitTarget(appState, event) : null;
        const mode = activeMode || hit?.mode;
        const cursors = {
            move: 'move',
            nw: 'nwse-resize',
            se: 'nwse-resize',
            ne: 'nesw-resize',
            sw: 'nesw-resize',
            n: 'ns-resize',
            s: 'ns-resize',
            e: 'ew-resize',
            w: 'ew-resize',
        };
        outputCanvas.style.cursor = cursors[mode] || 'grab';
    },

    renderOverlay(appState) {
        const placement = appState.manualPlacement;
        if (!appState.manualPlacementActive || !placement?.canvas || !placement.rect || !outputCtx) return;

        const rect = placement.rect;
        outputCtx.save();
        outputCtx.translate(viewOffset.x, viewOffset.y);
        outputCtx.scale(viewScale, viewScale);
        outputCtx.globalAlpha = 0.78;
        outputCtx.drawImage(placement.canvas, rect.x, rect.y, rect.width, rect.height);
        outputCtx.globalAlpha = 1;
        outputCtx.lineWidth = 2 / Math.max(viewScale, 0.001);
        outputCtx.strokeStyle = '#ffffff';
        outputCtx.setLineDash([8 / viewScale, 5 / viewScale]);
        outputCtx.strokeRect(rect.x, rect.y, rect.width, rect.height);
        outputCtx.setLineDash([]);

        const handleSize = this.HANDLE_SIZE / Math.max(viewScale, 0.001);
        const half = handleSize / 2;
        const handles = this._getHandles(rect);
        outputCtx.fillStyle = '#7c4dff';
        outputCtx.strokeStyle = '#ffffff';
        outputCtx.lineWidth = 1.5 / Math.max(viewScale, 0.001);
        for (const handle of handles) {
            outputCtx.fillRect(handle.x - half, handle.y - half, handleSize, handleSize);
            outputCtx.strokeRect(handle.x - half, handle.y - half, handleSize, handleSize);
        }
        outputCtx.restore();
    },
};

window.ManualPlacementHandler = ManualPlacementHandler;
