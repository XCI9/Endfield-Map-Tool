// ─────────────────────────────────────────────
// Matcher
// ORB feature-point matching using pre-computed .orbf fingerprints
// ─────────────────────────────────────────────

const Matcher = {

    // ── 相似變換 RANSAC 估算器 ─────────────────────────────────────────────
    // 等效於 Python 的 cv2.estimateAffinePartial2D(RANSAC)
    // 4-DOF：等比縮放 + 旋轉 + 平移，不含剪切與透視
    //   Transform: x' = a*x - b*y + tx
    //              y' = b*x + a*y + ty
    //   scale = sqrt(a² + b²)
    //
    // srcPts / dstPts: { x, y }[]
    // 回傳 { a, b, tx, ty, inliers: number[] } 或 null
    _estimateSimilarity(srcPts, dstPts, threshold = 5.0, maxIter = 1000, minInliers = 4) {
        const n = srcPts.length;
        if (n < minInliers) return null;

        const threshSq = threshold * threshold;
        let bestInliers = [];
        let bestA = 1, bestB = 0, bestTx = 0, bestTy = 0;

        // 給定 2 個點對，解析求解相似變換參數
        const fit2 = (i1, i2) => {
            const dxS = srcPts[i2].x - srcPts[i1].x;
            const dyS = srcPts[i2].y - srcPts[i1].y;
            const den = dxS * dxS + dyS * dyS;
            if (den < 1e-8) return null;
            const dxM = dstPts[i2].x - dstPts[i1].x;
            const dyM = dstPts[i2].y - dstPts[i1].y;
            const a  = (dxM * dxS + dyM * dyS) / den;
            const b  = (dyM * dxS - dxM * dyS) / den;
            const tx = dstPts[i1].x - a * srcPts[i1].x + b * srcPts[i1].y;
            const ty = dstPts[i1].y - b * srcPts[i1].x - a * srcPts[i1].y;
            return { a, b, tx, ty };
        };

        // RANSAC 主迴圈
        for (let iter = 0; iter < maxIter; iter++) {
            const i1 = Math.floor(Math.random() * n);
            let   i2 = Math.floor(Math.random() * (n - 1));
            if (i2 >= i1) i2++;

            const m = fit2(i1, i2);
            if (!m) continue;

            const inl = [];
            for (let i = 0; i < n; i++) {
                const ex = m.a * srcPts[i].x - m.b * srcPts[i].y + m.tx - dstPts[i].x;
                const ey = m.b * srcPts[i].x + m.a * srcPts[i].y + m.ty - dstPts[i].y;
                if (ex * ex + ey * ey < threshSq) inl.push(i);
            }
            if (inl.length > bestInliers.length) {
                bestInliers = inl;
                ({ a: bestA, b: bestB, tx: bestTx, ty: bestTy } = m);
            }
        }

        if (bestInliers.length < minInliers) return null;

        // 精煉：對所有內點做閉合式最小二乘（centroid 法，同 Python det 公式）
        let mpx = 0, mpy = 0, mqx = 0, mqy = 0;
        for (const i of bestInliers) {
            mpx += srcPts[i].x; mpy += srcPts[i].y;
            mqx += dstPts[i].x; mqy += dstPts[i].y;
        }
        const ni = bestInliers.length;
        mpx /= ni; mpy /= ni; mqx /= ni; mqy /= ni;

        let numA = 0, numB = 0, den = 0;
        for (const i of bestInliers) {
            const px_ = srcPts[i].x - mpx, py_ = srcPts[i].y - mpy;
            const qx_ = dstPts[i].x - mqx, qy_ = dstPts[i].y - mqy;
            numA += px_ * qx_ + py_ * qy_;
            numB += px_ * qy_ - py_ * qx_;
            den  += px_ * px_ + py_ * py_;
        }
        if (den < 1e-8) return null;

        const a  = numA / den;
        const b  = numB / den;
        const tx = mqx - a * mpx + b * mpy;
        const ty = mqy - b * mpx - a * mpy;

        return { a, b, tx, ty, inliers: bestInliers };
    },

    // _customLevel0Override is kept for API compatibility but ignored by ORB
    async processScreenshotAfterCrop(appState, canvas, _customLevel0Override = null) {
        if (appState.isProcessing) return;
        if (!grayBase) {
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
        let desBase   = null, bf        = null, matches   = null;

        try {
            const startTime = performance.now();
            appState.statusText = '⏳ 正在偵測截圖特徵點...';

            // ── 1. 讀入截圖並轉灰階 ──────────────────────────────────────────
            subMat  = cv.imread(canvas);
            graySub = new cv.Mat();
            cv.cvtColor(subMat, graySub, cv.COLOR_RGBA2GRAY);

            // ── 2. ORB 偵測截圖特徵點 ─────────────────────────────────────────
            // 參數與 fingerprintORB.py 保持一致：
            //   nfeatures=6000, scaleFactor=1.2, nlevels=8, edgeThreshold=15,
            //   firstLevel=0, WTA_K=2
            // scoreType/patchSize/fastThreshold 使用預設值（enum 未暴露於 OpenCV.js）
            orb       = new cv.ORB(6000, 1.2, 8, 15, 0, 2);
            kpSub     = new cv.KeyPointVector();
            desSub    = new cv.Mat();
            emptyMask = new cv.Mat();
            orb.detectAndCompute(graySub, emptyMask, kpSub, desSub);

            const nQuery = kpSub.size();
            if (nQuery < 4 || desSub.rows < 4) {
                appState.statusText = `❌ 截圖特徵點不足 (${nQuery} 個)，請使用包含更多細節的截圖`;
                return;
            }

            appState.statusText = `⏳ 正在比對 ${nQuery} 個特徵點...`;

            // ── 3. 載入指紋的 OpenCV 物件 ─────────────────────────────────────
            const { kps: kpsBase, desMat: desBaseMat } = FingerprintLoader.toOpenCV(orbFingerprint);
            desBase = desBaseMat;

            // ── 4. BFMatcher knnMatch (k=2，供 Lowe ratio 使用) ───────────────
            bf      = new cv.BFMatcher(cv.NORM_HAMMING, false);
            matches = new cv.DMatchVectorVector();
            bf.knnMatch(desSub, desBase, matches, 2);

            // ── 5. Lowe ratio test → 收集配對點座標（純 JS 陣列）─────────────
            const srcPtsArr = [], dstPtsArr = [];
            for (let i = 0; i < matches.size(); i++) {
                const row = matches.get(i);
                if (row.size() < 2) continue;
                const m = row.get(0);
                const n = row.get(1);
                if (m.distance < 0.75 * n.distance) {
                    const kpQ = kpSub.get(m.queryIdx);
                    const kpT = kpsBase[m.trainIdx];
                    srcPtsArr.push({ x: kpQ.pt.x, y: kpQ.pt.y });
                    dstPtsArr.push({ x: kpT.x,    y: kpT.y    });
                }
            }

            if (srcPtsArr.length < 4) {
                appState.statusText = `❌ 匹配特徵點不足 (${srcPtsArr.length} 個)，請嘗試包含更多地圖細節的截圖`;
                return;
            }

            // ── 6. RANSAC 相似變換估算 ────────────────────────────────────────
            // 等效 Python：cv2.estimateAffinePartial2D(RANSAC, reprojThreshold=5)
            const simResult = this._estimateSimilarity(srcPtsArr, dstPtsArr, 5.0, 1000);
            if (!simResult) {
                appState.statusText = `❌ 無法確認截圖位置 (RANSAC 失敗)，請嘗試其他截圖`;
                return;
            }
            const { a, b, tx, ty, inliers } = simResult;

            // ── 7. 將截圖 4 個角落映射至基底地圖座標 ─────────────────────────
            //   [x'] = [a  -b  tx] [x]      ← 同 Python cv2.transform(corners, M)
            //   [y']   [b   a  ty] [y]
            const W = canvas.width, H = canvas.height;
            const mappedCorners = [[0, 0], [W, 0], [W, H], [0, H]].map(([x, y]) => [
                a * x - b * y + tx,
                b * x + a * y + ty,
            ]);

            const xs = mappedCorners.map(p => p[0]);
            const ys = mappedCorners.map(p => p[1]);

            // ── 8. 輸出尺寸與定位 ─────────────────────────────────────────────
            // scale = sqrt(a² + b²)  ← 同 Python sqrt(|det(M[:,:2])|)
            const scale  = Math.sqrt(a * a + b * b);
            const finalW = Math.round(W * scale);
            const finalH = Math.round(H * scale);

            // 定位：映射角點的 bounding box 左上角（無旋轉時即為 tx, ty）
            const minX = Math.round(Math.min(...xs));
            const minY = Math.round(Math.min(...ys));

            const baseSize = CanvasManager.getBaseDimensions() || { width: grayBase.cols, height: grayBase.rows };
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
            appState.statusText = `✅ 成功！耗時: ${elapsed}ms，內點: ${inliers.length}，縮放比例: ${scale.toFixed(2)}`;
            appState.hasOutput = true;
            CanvasManager.resetView(appState.showOriginalBase);

        } finally {
            if (subMat)    subMat.delete();
            if (graySub)   graySub.delete();
            if (emptyMask) emptyMask.delete();
            if (orb)       orb.delete();
            if (kpSub)     kpSub.delete();
            if (desSub)    desSub.delete();
            if (desBase)   desBase.delete();
            if (bf)        bf.delete();
            if (matches)   matches.delete();
            appState.isProcessing = false;
        }
    }
};
