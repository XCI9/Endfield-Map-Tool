// ─────────────────────────────────────────────
// Matcher
// ORB feature-point matching using pre-computed .orbf fingerprints
// ─────────────────────────────────────────────

// ── desBase Mat 跨次快取 ──────────────────────────────────────────────────
// FingerprintLoader.toOpenCV() 每次都要複製 768KB (24000×32B)，
// 改為地圖不變時重用同一個 cv.Mat。
let _cachedDesBaseMat = null;
let _cachedFpRef      = null;   // 指向目前 orbFingerprint 物件的參考

const Matcher = {

    // 取得已快取的 desBase Mat；orbFingerprint 換圖時自動重建
    _getDesBase() {
        if (_cachedFpRef !== orbFingerprint) {
            if (_cachedDesBaseMat) { _cachedDesBaseMat.delete(); _cachedDesBaseMat = null; }
            if (orbFingerprint) {
                _cachedDesBaseMat = FingerprintLoader.toOpenCV(orbFingerprint).desMat;
            }
            _cachedFpRef = orbFingerprint;
        }
        return _cachedDesBaseMat;
    },

    // ── 相似變換 RANSAC 估算器 ─────────────────────────────────────────────
    // 等效於 Python 的 cv2.estimateAffinePartial2D(RANSAC)
    // 4-DOF：等比縮放 + 旋轉 + 平移，不含剪切與透視
    //   Transform: x' = a*x - b*y + tx
    //              y' = b*x + a*y + ty
    //
    // 使用 Float32Array 平坦陣列取代 {x,y}[] 物件，減少 GC 壓力與記憶體跳躍
    _estimateSimilarity(srcX, srcY, dstX, dstY, n, threshold = 5.0, maxIter = 500, minInliers = 1) {
        if (n < minInliers) return null;

        const threshSq = threshold * threshold;
        let bestCount = 0;
        let bestA = 1, bestB = 0, bestTx = 0, bestTy = 0;

        for (let iter = 0; iter < maxIter; iter++) {
            // 隨機抽 2 個點對
            const i1 = (Math.random() * n) | 0;
            let   i2 = (Math.random() * (n - 1)) | 0;
            if (i2 >= i1) i2++;

            const dxS = srcX[i2] - srcX[i1];
            const dyS = srcY[i2] - srcY[i1];
            const den = dxS * dxS + dyS * dyS;
            if (den < 1e-8) continue;

            const dxM = dstX[i2] - dstX[i1];
            const dyM = dstY[i2] - dstY[i1];
            const a  = (dxM * dxS + dyM * dyS) / den;
            const b  = (dyM * dxS - dxM * dyS) / den;
            const tx = dstX[i1] - a * srcX[i1] + b * srcY[i1];
            const ty = dstY[i1] - b * srcX[i1] - a * srcY[i1];

            // 計算內點數（不建立陣列，只計數）
            let cnt = 0;
            for (let i = 0; i < n; i++) {
                const ex = a * srcX[i] - b * srcY[i] + tx - dstX[i];
                const ey = b * srcX[i] + a * srcY[i] + ty - dstY[i];
                if (ex * ex + ey * ey < threshSq) cnt++;
            }
            if (cnt > bestCount) {
                bestCount = cnt;
                bestA = a; bestB = b; bestTx = tx; bestTy = ty;
                // 已找到足夠好的解，提前結束
                if (cnt > n * 0.8) break;
            }
        }

        if (bestCount < minInliers) return null;

        // 精煉：對所有內點做閉合式最小二乘（centroid 法）
        let mpx = 0, mpy = 0, mqx = 0, mqy = 0;
        const inlierIdx = [];
        for (let i = 0; i < n; i++) {
            const ex = bestA * srcX[i] - bestB * srcY[i] + bestTx - dstX[i];
            const ey = bestB * srcX[i] + bestA * srcY[i] + bestTy - dstY[i];
            if (ex * ex + ey * ey < threshSq) {
                inlierIdx.push(i);
                mpx += srcX[i]; mpy += srcY[i];
                mqx += dstX[i]; mqy += dstY[i];
            }
        }
        const ni = inlierIdx.length;
        mpx /= ni; mpy /= ni; mqx /= ni; mqy /= ni;

        let numA = 0, numB = 0, den2 = 0;
        for (const i of inlierIdx) {
            const px_ = srcX[i] - mpx, py_ = srcY[i] - mpy;
            const qx_ = dstX[i] - mqx, qy_ = dstY[i] - mqy;
            numA += px_ * qx_ + py_ * qy_;
            numB += px_ * qy_ - py_ * qx_;
            den2 += px_ * px_ + py_ * py_;
        }
        if (den2 < 1e-8) return null;

        const a  = numA / den2;
        const b  = numB / den2;
        const tx = mqx - a * mpx + b * mpy;
        const ty = mqy - b * mpx - a * mpy;

        return { a, b, tx, ty, inliers: inlierIdx };
    },

    // _customLevel0Override is kept for API compatibility but ignored by ORB
    async processScreenshotAfterCrop(appState, canvas, _customLevel0Override = null, _retryState = null, _retryFactor = 1.0) {
        if (appState.isProcessing && !_retryState) return;
        if (!baseMapSize) {
            appState.statusText = UIText.STATUS.BASE_MAP_NOT_LOADED;
            return;
        }
        if (!orbFingerprint) {
            appState.statusText = UIText.STATUS.ORB_NOT_LOADED;
            return;
        }

        const isRootCall = !_retryState;
        if (isRootCall) appState.isProcessing = true;

        let subMat    = null, graySub   = null, emptyMask = null;
        let orb       = null, kpSub     = null, desSub    = null;
        let bf        = null, matches   = null, alphaMask = null;

        try {
            const startTime = performance.now();

            // 內部重試狀態：當 inlier < 10 時按規則改變輸入尺寸重試
            const retryState = _retryState || (() => {
                const srcPixels = canvas.width * canvas.height;
                return {
                    baseCanvas: canvas,
                    srcPixels,
                    order: srcPixels < 250000 ? [2.0, 3.0, 4.0, 0.5] : [0.5, 0.33, 0.25, 2.],
                    tried: [],
                    best: null,
                    attemptInliers: [],
                };
            })();
            appState.statusText = UIText.STATUS.DETECTING_FEATURES;

            // ── 1. 讀入截圖並轉灰階 ──────────────────────────────────────────
            const t1 = performance.now();
            subMat  = cv.imread(canvas);   // RGBA 4 通道
            graySub = new cv.Mat();
            cv.cvtColor(subMat, graySub, cv.COLOR_RGBA2GRAY);

            // 建立 alpha mask：透明區域（alpha=0）不偵測特徵
            // cv.imread(canvas) 讀到的是 RGBA，用 split 拆出 4 個通道
            const channels = new cv.MatVector();
            cv.split(subMat, channels);
            alphaMask = channels.get(3);   // alpha 通道
            channels.get(0).delete(); channels.get(1).delete(); channels.get(2).delete();
            channels.delete();
            const { minVal: alphaMin, maxVal: alphaMax } = cv.minMaxLoc(alphaMask);
            if (alphaMax === 0) {
                appState.statusText = UIText.STATUS.SCREENSHOT_FULLY_TRANSPARENT;
                return;
            }
            if (alphaMin === 255) {
                // 全不透明（一般 JPG/截圖），不需要 mask，釋放改用空 Mat
                alphaMask.delete(); alphaMask = null;
                emptyMask = new cv.Mat();   // 只在此情況才建立
            }
            // 部分透明：alphaMask 有效，emptyMask 保持 null
            console.log(`[ORB] 1. imread+cvtColor: ${Math.round(performance.now()-t1)}ms`);

            // subMat（RGBA 原圖）到此已不再需要，立即釋放
            subMat.delete(); subMat = null;

            // ── 2. ORB 偵測截圖特徵點 ─────────────────────────────────────────
            // nfeatures=6000：提高初始偵測密度，由 step 3.5 grid dedup 攵至目標 2000 個
            // scoreType/patchSize/fastThreshold 使用預設值（enum 未暴露於 OpenCV.js）
            orb   = new cv.ORB(6000, 1.2, 8, 15, 0, 2);
            kpSub = new cv.KeyPointVector();
            desSub = new cv.Mat();
            const t2 = performance.now();
            // 有 alpha mask 則傳入，否則傳空 Mat
            orb.detectAndCompute(graySub, alphaMask ?? emptyMask, kpSub, desSub);
            const nQuery = kpSub.size();
            console.log(`[ORB] 2. detectAndCompute: ${Math.round(performance.now()-t2)}ms (${nQuery} kps)`);

            // detectAndCompute 完成，灰階圖與 mask 不再需要
            graySub.delete(); graySub = null;
            if (alphaMask) { alphaMask.delete(); alphaMask = null; }
            if (emptyMask) { emptyMask.delete(); emptyMask = null; }

            if (nQuery < 4 || desSub.rows < 4) {
                appState.statusText = UIText.STATUS.FEATURES_NOT_ENOUGH(nQuery);
                return;
            }

            // ── 3. 預先把截圖特徵點座標搬到 JS typed array ───────────────────
            // 避免 matches 迴圈中每次呼叫 kpSub.get(i) 跨越 WASM 邊界
            const t3 = performance.now();
            const qptX      = new Float32Array(nQuery);
            const qptY      = new Float32Array(nQuery);
            const qptAngle  = new Float32Array(nQuery);
            const qptResp   = new Float32Array(nQuery);
            for (let i = 0; i < nQuery; i++) {
                const kp = kpSub.get(i);
                qptX[i]     = kp.pt.x;
                qptY[i]     = kp.pt.y;
                qptAngle[i] = kp.angle;      // 度，-1 表示未定義
                qptResp[i]  = kp.response;   // FAST 評分，小崎排序用
            }
            console.log(`[ORB] 3. kpSub unpack: ${Math.round(performance.now()-t3)}ms`);

            // kpSub 座標已複製到 typed array，不再需要 WASM 物件
            kpSub.delete(); kpSub = null;

            // ── 3.5. 截圖特徵點空間去重（grid dedup）─────────────────
            // 固定 20×20 格；每格最小 8×8px（圖片過小時自動用 8px）
            // 每格上限 = min(5, ceil(2000 / nCells * 1.25))
            //   ×1.25：預留餘裕，因為實際上不是每格都能達到上限
            // 若原始特徵數 < 2000，直接跳過，不做任何過濾
            const DEDUP_SKIP_THRESHOLD = 2000;
            const GRID_DIVISIONS    = 20;
            const GRID_MIN_PX       = 8;
            const MAX_PER_CELL_CAP  = 5;

            const cellW  = Math.max(GRID_MIN_PX, Math.floor(canvas.width  / GRID_DIVISIONS));
            const cellH  = Math.max(GRID_MIN_PX, Math.floor(canvas.height / GRID_DIVISIONS));
            const gCols  = Math.ceil(canvas.width  / cellW);
            const gRows  = Math.ceil(canvas.height / cellH);
            const nCells = gCols * gRows;
            const maxPerCell = Math.ceil(DEDUP_SKIP_THRESHOLD / nCells * 2);

            let nKept;
            let fqptX, fqptY, fqptAngle;

            if (nQuery < DEDUP_SKIP_THRESHOLD) {
                nKept     = nQuery;
                fqptX     = qptX;
                fqptY     = qptY;
                fqptAngle = qptAngle;
                console.log(`[ORB] 3.5 grid dedup: skip (${nQuery} < ${DEDUP_SKIP_THRESHOLD})`);
            } else {
                const cells = new Array(nCells);
                for (let i = 0; i < nQuery; i++) {
                    const cx = Math.min((qptX[i] / cellW) | 0, gCols - 1);
                    const cy = Math.min((qptY[i] / cellH) | 0, gRows - 1);
                    const ci = cy * gCols + cx;
                    if (!cells[ci]) cells[ci] = [];
                    const cell = cells[ci];
                    const resp = qptResp[i];
                    if (cell.length < maxPerCell) {
                        cell.push({ idx: i, resp });
                        for (let j = cell.length - 1; j > 0 && cell[j].resp > cell[j-1].resp; j--) {
                            const tmp = cell[j]; cell[j] = cell[j-1]; cell[j-1] = tmp;
                        }
                    } else if (resp > cell[cell.length - 1].resp) {
                        cell[cell.length - 1] = { idx: i, resp };
                        for (let j = cell.length - 1; j > 0 && cell[j].resp > cell[j-1].resp; j--) {
                            const tmp = cell[j]; cell[j] = cell[j-1]; cell[j-1] = tmp;
                        }
                    }
                }
                const keptIdx = [];
                for (const cell of cells) { if (cell) for (const { idx } of cell) keptIdx.push(idx); }
                nKept = keptIdx.length;
                console.log(`[ORB] 3.5 grid dedup: ${nQuery} → ${nKept} kps (${gCols}×${gRows} 格, 每格 ${cellW}×${cellH}px, max ${maxPerCell}/格)`);

                fqptX       = new Float32Array(nKept);
                fqptY       = new Float32Array(nKept);
                fqptAngle   = new Float32Array(nKept);
                const filteredDes = new cv.Mat(nKept, 32, cv.CV_8UC1);
                const rawSrc = desSub.data;
                const rawDst = filteredDes.data;
                for (let j = 0; j < nKept; j++) {
                    const i = keptIdx[j];
                    fqptX[j]     = qptX[i];
                    fqptY[j]     = qptY[i];
                    fqptAngle[j] = qptAngle[i];
                    rawDst.set(rawSrc.subarray(i * 32, i * 32 + 32), j * 32);
                }
                desSub.delete();
                desSub = filteredDes;
            }

            if (nKept < 4) {
                appState.statusText = UIText.STATUS.FEATURES_NOT_ENOUGH_AFTER_DEDUP(nKept);
                return;
            }

            appState.statusText = UIText.STATUS.MATCHING_IN_PROGRESS(nKept);

            // ── 4. 取得快取的 desBase Mat（避免每次重複複製 768KB）────────────
            const desBase = this._getDesBase();   // ⚠️ 快取物件，不可在 finally 刪除
            const kpsBase = orbFingerprint.kps;

            // ── 5. BFMatcher knnMatch (k=2，供 Lowe ratio 使用) ───────────────
            bf      = new cv.BFMatcher(cv.NORM_HAMMING, false);
            matches = new cv.DMatchVectorVector();
            const t5 = performance.now();
            bf.knnMatch(desSub, desBase, matches, 2);
            console.log(`[ORB] 5. knnMatch: ${Math.round(performance.now()-t5)}ms (${desSub.rows} query × ${desBase.rows} train)`);

            // knnMatch 完成，descriptor Mat 與 matcher 不再需要
            desSub.delete(); desSub = null;
            bf.delete(); bf = null;

            // ── 6. Lowe ratio test → 收集配對點座標（flat typed arrays）────────
            const mSize = matches.size();
            // 預先分配最大可能大小，避免動態 push
            const srcX = new Float32Array(mSize);
            const srcY = new Float32Array(mSize);
            const dstX = new Float32Array(mSize);
            const dstY = new Float32Array(mSize);
            const ANGLE_THRESHOLD = 30;   // 容許的最大角度差（度）
            let loweN = 0;   // 通過 Lowe ratio 的數量
            let goodN = 0;   // 再通過角度過濾的數量

            const t6 = performance.now();
            for (let i = 0; i < mSize; i++) {
                const row = matches.get(i);
                if (row.size() < 2) continue;
                const m = row.get(0);
                const r = row.get(1);
                if (m.distance >= 0.8 * r.distance) continue;

                loweN++;
                const qi = m.queryIdx;
                const ti = m.trainIdx;


                srcX[goodN] = fqptX[qi];
                srcY[goodN] = fqptY[qi];
                dstX[goodN] = kpsBase[ti].x;
                dstY[goodN] = kpsBase[ti].y;
                goodN++;
            }
            console.log(`[ORB] 6. Lowe ratio: ${Math.round(performance.now()-t6)}ms  Lowe=${loweN} → 角度過濾後=${goodN} (閾値 ±${ANGLE_THRESHOLD}°)`);

            // matches 已遍歷完畢，立即釋放（最大的 WASM 暫存物件之一）
            matches.delete(); matches = null;

            if (goodN < 4) {
                appState.statusText = UIText.STATUS.MATCHING_NOT_ENOUGH(goodN);
                return;
            }

            // ── 7. RANSAC 相似變換估算 ────────────────────────────────────────
            // 等效 Python：cv2.estimateAffinePartial2D(RANSAC, reprojThreshold=5)
            const t7 = performance.now();
            const simResult = this._estimateSimilarity(
                srcX.subarray(0, goodN), srcY.subarray(0, goodN),
                dstX.subarray(0, goodN), dstY.subarray(0, goodN),
                goodN, 5.0, 500
            );
            if (!simResult) {
                retryState.attemptInliers.push({ factor: _retryFactor, inliers: 0, ok: false });
                const summary = retryState.attemptInliers
                    .map((x) => `${x.factor}x=${x.inliers}${x.ok ? '' : '(fail)'}`)
                    .join(', ');
                console.log(`[ORB] 7. RANSAC: ${Math.round(performance.now()-t7)}ms (factor=${_retryFactor}x, inliers=0) | attempts: ${summary}`);
                appState.statusText = UIText.STATUS.RANSAC_FAILED;
                return;
            }
            const { a, b, tx, ty, inliers } = simResult;
            retryState.attemptInliers.push({ factor: _retryFactor, inliers: inliers.length, ok: true });
            const summary = retryState.attemptInliers
                .map((x) => `${x.factor}x=${x.inliers}${x.ok ? '' : '(fail)'}`)
                .join(', ');
            console.log(`[ORB] 7. RANSAC: ${Math.round(performance.now()-t7)}ms (factor=${_retryFactor}x, inliers=${inliers.length}) | attempts: ${summary}`);

            // 記錄目前嘗試的候選結果，供「全部 <10 inlier」時採用最佳值
            const currentCandidate = {
                factor: _retryFactor,
                canvas,
                a, b, tx, ty,
                inliers,
                inliersCount: inliers.length,
                goodN,
            };
            if (!retryState.best
                || currentCandidate.inliersCount > retryState.best.inliersCount
                || (currentCandidate.inliersCount === retryState.best.inliersCount && currentCandidate.goodN > retryState.best.goodN)) {
                retryState.best = currentCandidate;
            }

            // 內點不足時自動重試：
            // 1) srcPixels < 250000: 2x -> 0.5x
            // 2) srcPixels >= 250000: 0.5x -> 2x
            if (inliers.length < 10) {
                const nextFactor = retryState.order.find((f) => !retryState.tried.includes(f));
                if (nextFactor !== undefined) {
                    retryState.tried.push(nextFactor);
                    const src = retryState.baseCanvas;
                    const rw = Math.max(1, Math.round(src.width * nextFactor));
                    const rh = Math.max(1, Math.round(src.height * nextFactor));
                    const retryCanvas = document.createElement('canvas');
                    retryCanvas.width = rw;
                    retryCanvas.height = rh;
                    const rctx = retryCanvas.getContext('2d');
                    rctx.imageSmoothingEnabled = true;
                    rctx.imageSmoothingQuality = 'high';
                    rctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, rw, rh);

                    appState.statusText = UIText.STATUS.LOW_INLIERS_RETRY(inliers.length, nextFactor, retryState.tried.length, retryState.order.length);
                    return await this.processScreenshotAfterCrop(appState, retryCanvas, _customLevel0Override, retryState, nextFactor);
                }

                // 已無可重試倍率：採用所有嘗試中的最佳結果（不是最後一次）
                if (retryState.best) {
                    appState.statusText = UIText.STATUS.LOW_INLIERS_USE_BEST(retryState.best.inliersCount, retryState.best.factor);
                }
            }

            // 若最佳候選不是目前這次，切換後續使用的參數
            const chosen = (inliers.length < 10 && retryState.best) ? retryState.best : currentCandidate;
            const chosenCanvas = chosen.canvas;
            const chosenA = chosen.a;
            const chosenB = chosen.b;
            const chosenTx = chosen.tx;
            const chosenTy = chosen.ty;
            const chosenInliers = chosen.inliers;

            // ── 8. 將截圖 4 個角落映射至基底地圖座標 ─────────────────────────
            //   [x'] = [a  -b  tx] [x]      ← 同 Python cv2.transform(corners, M)
            //   [y']   [b   a  ty] [y]
            const W = chosenCanvas.width, H = chosenCanvas.height;
            const mappedCorners = [[0, 0], [W, 0], [W, H], [0, H]].map(([x, y]) => [
                chosenA * x - chosenB * y + chosenTx,
                chosenB * x + chosenA * y + chosenTy,
            ]);

            const xs = mappedCorners.map(p => p[0]);
            const ys = mappedCorners.map(p => p[1]);

            // scale = sqrt(a² + b²)  ← 同 Python sqrt(|det(M[:,:2])|)
            const scale  = Math.sqrt(chosenA * chosenA + chosenB * chosenB);
            const finalW = Math.round(W * scale);
            const finalH = Math.round(H * scale);

            const minX = Math.round(Math.min(...xs));
            const minY = Math.round(Math.min(...ys));

            const baseSize = CanvasManager.getBaseDimensions() || { width: baseMapSize.width, height: baseMapSize.height };
            const clampedX = Math.max(0, minX);
            const clampedY = Math.max(0, minY);
            const rect = new cv.Rect(
                clampedX,
                clampedY,
                Math.min(finalW, baseSize.width  - clampedX),
                Math.min(finalH, baseSize.height - clampedY)
            );

            // ── 9. 建立 historyCanvas（截圖縮放至在地圖上的尺寸）────────────
            const historyCanvas = document.createElement('canvas');
            historyCanvas.width  = finalW;
            historyCanvas.height = finalH;
            const hCtx = historyCanvas.getContext('2d');
            hCtx.imageSmoothingEnabled = true;
            hCtx.imageSmoothingQuality = 'high';
            hCtx.drawImage(chosenCanvas, 0, 0, chosenCanvas.width, chosenCanvas.height, 0, 0, finalW, finalH);

            History.addRecord(
                appState,
                chosenCanvas,
                historyCanvas,
                rect,
                scale,
                appState.enhanceMapBoundaryBrightness
            );

            const elapsed = Math.round(performance.now() - startTime);
            console.log(`[ORB] Final inliers: ${chosenInliers.length}`);
            console.log(`[ORB] ── total: ${elapsed}ms ──`);
            appState.statusText = UIText.STATUS.MATCH_SUCCESS(elapsed, chosenInliers.length, scale);
            appState.hasOutput = true;
            CanvasManager.resetView(appState.showOriginalBase);

        } finally {
            // ⚠️ desBase 由快取管理，不在此刪除
            if (subMat)    subMat.delete();
            if (graySub)   graySub.delete();
            if (alphaMask) alphaMask.delete();
            if (emptyMask) emptyMask.delete();
            if (orb)       orb.delete();
            if (kpSub)     kpSub.delete();
            if (desSub)    desSub.delete();
            if (bf)        bf.delete();
            if (matches)   matches.delete();
            if (isRootCall) appState.isProcessing = false;
        }
    }
};
