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
    _estimateSimilarity(srcX, srcY, dstX, dstY, n, threshold = 5.0, maxIter = 500, minInliers = 4) {
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
    async processScreenshotAfterCrop(appState, canvas, _customLevel0Override = null) {
        if (appState.isProcessing) return;
        if (!baseMapSize) {
            appState.statusText = '❌ 基底地圖尚未載入';
            return;
        }
        if (!orbFingerprint) {
            appState.statusText = '❌ ORB 指紋尚未載入，請稍候或重新選擇地圖';
            return;
        }

        appState.isProcessing = true;

        let subMat    = null, graySub   = null, emptyMask = null;
        let orb       = null, kpSub     = null, desSub    = null;
        let bf        = null, matches   = null, alphaMask = null;

        try {
            const startTime = performance.now();
            appState.statusText = '⏳ 正在偵測截圖特徵點...';

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
                appState.statusText = '❌ 截圖全透明，無法偵測特徵點';
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
            // nfeatures=2000：比 6000 快 3x，又足夠提供良好配對數量
            // scoreType/patchSize/fastThreshold 使用預設值（enum 未暴露於 OpenCV.js）
            orb   = new cv.ORB(2000, 1.2, 8, 15, 0, 2);
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
                appState.statusText = `❌ 截圖特徵點不足 (${nQuery} 個)，請使用包含更多細節的截圖`;
                return;
            }

            // ── 3. 預先把截圖特徵點座標搬到 JS typed array ───────────────────
            // 避免 matches 迴圈中每次呼叫 kpSub.get(i) 跨越 WASM 邊界
            const t3 = performance.now();
            const qptX = new Float32Array(nQuery);
            const qptY = new Float32Array(nQuery);
            for (let i = 0; i < nQuery; i++) {
                const kp = kpSub.get(i);
                qptX[i] = kp.pt.x;
                qptY[i] = kp.pt.y;
            }
            console.log(`[ORB] 3. kpSub unpack: ${Math.round(performance.now()-t3)}ms`);

            // kpSub 座標已複製到 typed array，不再需要 WASM 物件
            kpSub.delete(); kpSub = null;

            appState.statusText = `⏳ 正在比對 ${nQuery} 個特徵點...`;

            // ── 4. 取得快取的 desBase Mat（避免每次重複複製 768KB）────────────
            const desBase = this._getDesBase();   // ⚠️ 快取物件，不可在 finally 刪除
            const kpsBase = orbFingerprint.kps;

            // ── 5. BFMatcher knnMatch (k=2，供 Lowe ratio 使用) ───────────────
            bf      = new cv.BFMatcher(cv.NORM_HAMMING, false);
            matches = new cv.DMatchVectorVector();
            const t5 = performance.now();
            bf.knnMatch(desSub, desBase, matches, 2);
            console.log(`[ORB] 5. knnMatch: ${Math.round(performance.now()-t5)}ms (${nQuery} query × ${desBase.rows} train)`);

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
            let goodN = 0;

            const t6 = performance.now();
            for (let i = 0; i < mSize; i++) {
                const row = matches.get(i);
                if (row.size() < 2) continue;
                const m = row.get(0);
                const r = row.get(1);
                if (m.distance < 0.75 * r.distance) {
                    const qi = m.queryIdx;
                    const ti = m.trainIdx;
                    srcX[goodN] = qptX[qi];
                    srcY[goodN] = qptY[qi];
                    dstX[goodN] = kpsBase[ti].x;
                    dstY[goodN] = kpsBase[ti].y;
                    goodN++;
                }
            }
            console.log(`[ORB] 6. Lowe ratio: ${Math.round(performance.now()-t6)}ms (goodN=${goodN})`);

            // matches 已遍歷完畢，立即釋放（最大的 WASM 暫存物件之一）
            matches.delete(); matches = null;

            if (goodN < 4) {
                appState.statusText = `❌ 匹配特徵點不足 (${goodN} 個)，請嘗試包含更多地圖細節的截圖`;
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
            console.log(`[ORB] 7. RANSAC: ${Math.round(performance.now()-t7)}ms`);
            if (!simResult) {
                appState.statusText = `❌ 無法確認截圖位置 (RANSAC 失敗)，請嘗試其他截圖`;
                return;
            }
            const { a, b, tx, ty, inliers } = simResult;

            // ── 8. 將截圖 4 個角落映射至基底地圖座標 ─────────────────────────
            //   [x'] = [a  -b  tx] [x]      ← 同 Python cv2.transform(corners, M)
            //   [y']   [b   a  ty] [y]
            const W = canvas.width, H = canvas.height;
            const mappedCorners = [[0, 0], [W, 0], [W, H], [0, H]].map(([x, y]) => [
                a * x - b * y + tx,
                b * x + a * y + ty,
            ]);

            const xs = mappedCorners.map(p => p[0]);
            const ys = mappedCorners.map(p => p[1]);

            // scale = sqrt(a² + b²)  ← 同 Python sqrt(|det(M[:,:2])|)
            const scale  = Math.sqrt(a * a + b * b);
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
            hCtx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, finalW, finalH);

            History.addRecord(appState, canvas, historyCanvas, rect, scale);

            const elapsed = Math.round(performance.now() - startTime);
            console.log(`[ORB] ── total: ${elapsed}ms ──`);
            appState.statusText = `✅ 成功！耗時: ${elapsed}ms，內點: ${inliers.length}，縮放比例: ${scale.toFixed(2)}`;
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
            appState.isProcessing = false;
        }
    }
};
