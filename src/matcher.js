// ─────────────────────────────────────────────
// Matcher
// Template matching with multi-worker parallelism
// and multi-scale hierarchical search
// ─────────────────────────────────────────────

const Matcher = {
    async performTemplateMatch(appState, baseMatRef, templateMatRef, scaleDownRes, roiCandidates, scaleRange, step, statusPrefix, _preScaledBase = null, templateMaskRef = null) {
        // Use caller-supplied pre-scaled base when available (avoids re-resizing
        // the same image for every candidate at the same level)
        let scaledBase, ownScaledBase;
        if (_preScaledBase) {
            scaledBase = _preScaledBase;
            ownScaledBase = false;
        } else {
            scaledBase = new cv.Mat();
            cv.resize(baseMatRef, scaledBase, new cv.Size(), scaleDownRes, scaleDownRes, cv.INTER_AREA);
            ownScaledBase = true;
        }

        // Build scale list
        let scales = [];
        let s = scaleRange.min;
        while (s <= scaleRange.max) {
            const finalS = s * scaleDownRes;
            const newWidth = Math.round(templateMatRef.cols * finalS);
            const newHeight = Math.round(templateMatRef.rows * finalS);
            if (newWidth >= 20 && newHeight >= 20) scales.push(s);
            s *= 1 + Math.max(0.01, step);
        }

        if (scales.length === 0) {
            scaledBase.delete();
            return [];
        }

        // Fallback to main thread if no workers
        if (workers.length === 0 || scales.length < 2) {
            console.warn('No workers available, running on main thread');
            const results = this.runMatchLocal(scaledBase, templateMatRef, scaleDownRes, roiCandidates, scales, templateMaskRef);
            if (ownScaledBase) scaledBase.delete();
            return results;
        }

        // Split scales across workers
        const chunks = Array.from({ length: workers.length }, () => []);
        scales.forEach((sc, i) => chunks[i % workers.length].push(sc));

        // Use SharedArrayBuffer if available (zero-copy across workers)
        const useSharedBuffer = typeof SharedArrayBuffer !== 'undefined';

        let baseData, templateData, maskData;
        if (useSharedBuffer) {
            const baseBuf = new SharedArrayBuffer(scaledBase.data.length);
            new Uint8Array(baseBuf).set(scaledBase.data);
            baseData = new Uint8Array(baseBuf);

            const tplBuf = new SharedArrayBuffer(templateMatRef.data.length);
            new Uint8Array(tplBuf).set(templateMatRef.data);
            templateData = new Uint8Array(tplBuf);

            if (templateMaskRef) {
                const maskBuf = new SharedArrayBuffer(templateMaskRef.data.length);
                new Uint8Array(maskBuf).set(templateMaskRef.data);
                maskData = new Uint8Array(maskBuf);
            }
        } else {
            baseData = new Uint8Array(scaledBase.data);
            templateData = new Uint8Array(templateMatRef.data);
            if (templateMaskRef) maskData = new Uint8Array(templateMaskRef.data);
        }

        const basePayload = { rows: scaledBase.rows, cols: scaledBase.cols, type: scaledBase.type(), data: baseData };
        const templatePayload = { rows: templateMatRef.rows, cols: templateMatRef.cols, type: templateMatRef.type(), data: templateData };
        const maskPayload = templateMaskRef ? { rows: templateMaskRef.rows, cols: templateMaskRef.cols, type: templateMaskRef.type(), data: maskData } : null;

        const promises = workers.map((worker, index) => new Promise((resolve, reject) => {
            const id = `${Date.now()}_${index}`;
            const handleMsg = (e) => {
                if (e.data.id !== id) return;
                worker.removeEventListener('message', handleMsg);
                e.data.type === 'result' ? resolve(e.data.results) : reject(e.data.error);
            };
            worker.addEventListener('message', handleMsg);
            worker.postMessage({
                cmd: 'match', id,
                payload: { baseData: basePayload, templateData: templatePayload, maskData: maskPayload, scaleDownRes, roiCandidates, scaleRange: { min: 0, max: 0 }, scales: chunks[index], step }
            });
        }));

        appState.statusText = `⏳ ${statusPrefix}... (並行運算中)`;

        try {
            const allResults = (await Promise.all(promises)).flat();
            if (ownScaledBase) scaledBase.delete();
            return this._deduplicateResults(allResults, 5);
        } catch (e) {
            console.error('Worker error', e);
            if (ownScaledBase) scaledBase.delete();
            return [];
        }
    },

    runMatchLocal(scaledBase, templateImg, scaleDownRes, roiCandidates, scales, templateMask) {
        if (window.runTemplateMatch) {
            return window.runTemplateMatch(cv, scaledBase, templateImg, scaleDownRes, roiCandidates, scales, templateMask);
        }
        console.error('match-logic.js not loaded');
        return [];
    },

    _deduplicateResults(results, keepTop) {
        results.sort((a, b) => b.val - a.val);
        const unique = [];
        for (const res of results) {
            const isClose = unique.some(u =>
                Math.abs(u.loc.x - res.loc.x) < 10 &&
                Math.abs(u.loc.y - res.loc.y) < 10 &&
                Math.abs(u.scale - res.scale) < 0.1
            );
            if (!isClose) unique.push(res);
            if (unique.length >= keepTop) break;
        }
        return unique;
    },

    async processScreenshotAfterCrop(appState, canvas) {
        if (appState.isProcessing) return;
        if (!grayBase) {
            appState.statusText = '❌ 基底地圖尚未載入';
            return;
        }

        appState.isProcessing = true;
        try {
            const startTime = performance.now();
            appState.statusText = '⏳ 正在搜尋最佳位置與比例...';

            const subMat = cv.imread(canvas);

            // ── Transparency handling ─────────────────────────────────────────
            // Extract alpha channel once; reused as matchTemplate mask and
            // compositing mask.
            const rgbaPlanes = new cv.MatVector();
            cv.split(subMat, rgbaPlanes);
            const alphaMask = rgbaPlanes.get(3).clone();
            for (let i = 0; i < rgbaPlanes.size(); i++) rgbaPlanes.get(i).delete();
            rgbaPlanes.delete();

            // Detect if image actually has transparent pixels.
            // If fully opaque → matchMask = null (skip mask overhead entirely)
            const totalPixels = alphaMask.rows * alphaMask.cols;
            const opaquePixels = cv.countNonZero(alphaMask);
            const matchMask = (opaquePixels < totalPixels) ? alphaMask : null;

            const graySub = new cv.Mat();
            cv.cvtColor(subMat, graySub, cv.COLOR_RGBA2GRAY);
            // ─────────────────────────────────────────────────────────────────

            let currentScaleRes = SCALE_DOWN;

            const searchLevels = [
                { scaleRes: SCALE_DOWN * 0.25, roiMargin: 0,  scaleRange: { min: 0.5, max: 5 }, step: 0.1,  threshold: 0.2, status: '粗略搜尋中', keepTop: 10 },
                { scaleRes: SCALE_DOWN * 0.5,  roiMargin: 30, scaleRange: { range: 0.2 },        step: 0.05, threshold: 0.3, status: '中等搜尋中', keepTop: 5 },
                { scaleRes: SCALE_DOWN,         roiMargin: 20, scaleRange: { range: 0.05 },       step: 0.03, threshold: 0.35, status: '精確搜尋中', keepTop: 1 },
                { scaleRes: SCALE_DOWN * 2,     roiMargin: 10, scaleRange: { range: 0.03 },       step: 0.01, threshold: 0.4,  status: '確認結果中', keepTop: 1 }
            ];

            let currentCandidates = null;
            let prevScaleRes = 1;

            for (let i = 0; i < searchLevels.length; i++) {
                const level = searchLevels[i];
                let nextRoiCandidates = [];

                if (i === 0) {
                    nextRoiCandidates = null;
                } else if (currentCandidates && currentCandidates.length > 0) {
                    for (const cand of currentCandidates) {
                        const ratio = level.scaleRes / prevScaleRes;
                        nextRoiCandidates.push({
                            x: cand.loc.x * ratio - level.roiMargin,
                            y: cand.loc.y * ratio - level.roiMargin,
                            width: graySub.cols * cand.scale * level.scaleRes + level.roiMargin * 2,
                            height: graySub.rows * cand.scale * level.scaleRes + level.roiMargin * 2,
                            baseScale: cand.scale
                        });
                    }
                } else {
                    break;
                }

                let levelResults = [];

                if (i === 0) {
                    levelResults = await this.performTemplateMatch(appState, grayBase, graySub, level.scaleRes, null, level.scaleRange, level.step, level.status, null, matchMask);
                } else {
                    // Pre-scale base ONCE for this level, then share it across all candidate
                    // calls – eliminates O(candidates − 1) redundant cv.resize() operations
                    const levelScaledBase = new cv.Mat();
                    cv.resize(grayBase, levelScaledBase, new cv.Size(), level.scaleRes, level.scaleRes, cv.INTER_AREA);

                    appState.statusText = `⏳ ${level.status} (檢查 ${nextRoiCandidates.length} 個候選位置)...`;

                    // Fire all candidate matches in parallel so the worker pool
                    // stays fully loaded instead of idling between sequential awaits
                    const candidatePromises = nextRoiCandidates.map((roiCand, cIdx) => {
                        const range = {
                            min: Math.max(0.5, roiCand.baseScale - level.scaleRange.range),
                            max: Math.min(5,   roiCand.baseScale + level.scaleRange.range)
                        };
                        return this.performTemplateMatch(appState, grayBase, graySub, level.scaleRes, [roiCand], range, level.step, `${level.status} ${cIdx + 1}/${nextRoiCandidates.length}`, levelScaledBase, matchMask);
                    });

                    const subResults = await Promise.all(candidatePromises);
                    levelResults = subResults.flat();
                    levelScaledBase.delete();
                }

                levelResults = levelResults.filter(r => r.val >= level.threshold);
                currentCandidates = this._deduplicateResults(levelResults, level.keepTop);
                prevScaleRes = level.scaleRes;
                currentScaleRes = level.scaleRes;

                if (currentCandidates.length === 0) break;
            }

            const bestResult = currentCandidates?.[0] ?? null;

            if (bestResult && bestResult.val > 0.4) {
                let { loc: bestLoc, val: bestVal, scale: bestScale } = bestResult;

                if (currentScaleRes !== SCALE_DOWN) {
                    bestLoc = {
                        x: bestLoc.x * (SCALE_DOWN / currentScaleRes),
                        y: bestLoc.y * (SCALE_DOWN / currentScaleRes)
                    };
                }

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

                // Resize alpha mask to final dimensions for compositing
                const finalAlphaMask = new cv.Mat();
                cv.resize(alphaMask, finalAlphaMask, new cv.Size(finalW, finalH));

                const roi = baseMat.roi(rect);
                const clippedSub = finalSub.roi(new cv.Rect(0, 0, rect.width, rect.height));
                const clippedAlphaMask = finalAlphaMask.roi(new cv.Rect(0, 0, rect.width, rect.height));
                clippedSub.copyTo(roi, clippedAlphaMask); // only write non-transparent pixels
                clippedAlphaMask.delete();
                finalAlphaMask.delete();

                CanvasManager.syncBaseCanvasSizes();
                cv.imshow('baseCanvas', baseMat);
                CanvasManager.updateOverlayCanvas(finalSub, rect);

                const historyCanvas = document.createElement('canvas');
                historyCanvas.width = finalSub.cols;
                historyCanvas.height = finalSub.rows;
                cv.imshow(historyCanvas, finalSub);

                appState.history.push({ canvas: historyCanvas, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
                appState.canUndo = true;

                CanvasManager.renderView(appState.showOriginalBase);
                ExportHandler.updatePreview(appState);
                const endTime = performance.now();
                appState.statusText = `✅ 成功！耗時: ${Math.round(endTime - startTime)}ms, 相似度: ${Math.round(bestVal * 100)}%, 縮放比例: ${bestScale.toFixed(2)}`;
                appState.hasOutput = true;
                CanvasManager.resetView(appState.showOriginalBase);

                roi.delete();
                clippedSub.delete();
                finalSub.delete();
            } else {
                appState.statusText = '❌ 找不到匹配位置，請嘗試其他截圖或檢查內容';
            }

            if (searchBase && !searchBase.isDeleted()) searchBase.delete();
            subMat.delete();
            graySub.delete();
            alphaMask.delete();
        } finally {
            appState.isProcessing = false;
        }
    }
};
