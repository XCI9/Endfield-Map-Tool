"""
MapMatcher – ORB 多尺度版本
  * 萃取時在多個縮放層對地圖提取 ORB 特徵 → 解決 ORB 縮放不變性有限的問題
  * 所有特徵點座標反算回原始地圖尺寸，BFMatcher 直接得到正確位置
  * estimateAffinePartial2D + RANSAC 精確定位
  * 辨識結果在地圖上畫出邊框並儲存

使用方式：
  1. 開發端：萃取地圖特徵並存檔（只需執行一次）
       python fingerprintORB.py --extract

  2. 辨識端：比對截圖
       python fingerprintORB.py --match crop.png

  3. 直接執行（自動提取 + 比對預設測試圖）
       python fingerprintORB.py
"""

import cv2
import numpy as np
import struct
import sys
import os

# ── 縮放層級設定 ──────────────────────────────────────────────────────────────
# 每個縮放層 s 可辨識的截圖縮放倍率 t 範圍（ORB nlevels=8, scaleFactor=1.2 → 約 3.58× 金字塔深度）
#   s=2.00 → t ∈ [0.50,  1.8]   ← 截圖放大（縮放比 < 1x）
#   s=1.00 → t ∈ [1.00,  3.6]
#   s=0.50 → t ∈ [2.00,  7.2]
#   s=0.25 → t ∈ [4.00, 14.3]   ← 截圖縮小（縮放比 10x 落在此層）
# 合計覆蓋 t ∈ [0.5, 14.3]，支援 0.5× ~ 10× 縮放範圍
SCALE_LEVELS       = [2.0, 1.0, 0.5, 0.25]
FEATURES_PER_LEVEL = 20000   # 每個縮放層抽取的最大特徵數


class MapMatcher:

    def __init__(self, n_features=FEATURES_PER_LEVEL):
        self.orb = cv2.ORB_create(
            nfeatures=n_features,
            scaleFactor=1.2,
            nlevels=8,
            edgeThreshold=15,
            patchSize=31,
        )
        # BFMatcher + Hamming，crossCheck=False 才能使用 knnMatch
        self.bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)

        self.kp_large  = None
        self.des_large = None
        self.map_size  = (0, 0)

    # ─── Feature Serialization ────────────────────────────────────────────────

    def extract_and_save(self, large_img_path, output_file):
        """萃取多尺度 ORB 特徵並儲存成 .orbf (原始二進位) 檔"""
        img_raw = cv2.imread(large_img_path, cv2.IMREAD_UNCHANGED)
        if img_raw is None:
            raise FileNotFoundError(f'Cannot load image: {large_img_path}')

        # 分離 alpha 通道（若有），轉灰階供 ORB 使用
        if img_raw.ndim == 2:
            img   = img_raw
            alpha = None
        elif img_raw.shape[2] == 4:
            img   = cv2.cvtColor(img_raw, cv2.COLOR_BGRA2GRAY)
            alpha = img_raw[:, :, 3]   # shape (H, W)，0=全透明，255=不透明
        else:
            img   = cv2.cvtColor(img_raw, cv2.COLOR_BGR2GRAY)
            alpha = None

        orig_h, orig_w = img.shape
        has_alpha = alpha is not None
        print(f'[ORB] Base map: {large_img_path} ({orig_w}x{orig_h}){" [has alpha]" if has_alpha else ""}')

        all_kp_tuples = []   # (x, y, size, angle, octave, class_id)
        all_des_list  = []

        # ── 空間去重參數（每個 scale 層獨立套用）──────────────────────────
        DEDUP_GRID    = 35   # 格子大小（原始地圖像素），越小保留越多
        MAX_PER_CELL  = 2    # 每格最多保留幾個特徵
        from collections import defaultdict

        total_before_dedup = 0
        total_alpha_removed = 0

        for scale in SCALE_LEVELS:
            if scale == 1.0:
                img_s = img
                alpha_s = alpha
            else:
                sw     = max(1, int(orig_w * scale))
                sh     = max(1, int(orig_h * scale))
                interp = cv2.INTER_CUBIC if scale > 1.0 else cv2.INTER_AREA
                img_s  = cv2.resize(img, (sw, sh), interpolation=interp)
                alpha_s = None if alpha is None else cv2.resize(alpha, (sw, sh), interpolation=cv2.INTER_NEAREST)

            # 對 alpha mask 往不透明區域內縮 5px（以原圖座標計，隨 scale 等比換算）
            # 避免在透明邊界附近產生不穩定特徵點
            mask_for_orb = None
            mask_pad_px = 0
            if alpha_s is not None:
                mask_for_orb = ((alpha_s > 0).astype(np.uint8) * 255)
                mask_pad_px = max(1, int(round(5 * scale)))
                k = mask_pad_px * 2 + 1
                kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
                mask_for_orb = cv2.erode(mask_for_orb, kernel, iterations=1)
                if cv2.countNonZero(mask_for_orb) == 0:
                    print(f'  scale={scale:.3f}: mask empty after inward pad ({mask_pad_px}px), skip')
                    continue

            kp_list, des = self.orb.detectAndCompute(img_s, mask_for_orb)
            if des is None or len(kp_list) == 0:
                print(f'  scale={scale:.3f}: no keypoints, skip')
                continue

            alpha_info = f' [alpha mask, inward pad={mask_pad_px}px]' if alpha_s is not None else ''
            print(f'  scale={scale:.3f} ({img_s.shape[1]}x{img_s.shape[0]}): {len(kp_list)} keypoints{alpha_info}')

            kp_tuples_scale = []
            for kp in kp_list:
                ox, oy = kp.pt
                kp_tuples_scale.append((
                    ox / scale,          # x  (original map coords)
                    oy / scale,          # y
                    kp.size / scale,     # size
                    kp.angle,            # angle (degrees, -1 = unset)
                    kp.octave & 0xFF,    # octave
                    kp.class_id,         # class_id
                ))
            total_before_dedup += len(kp_tuples_scale)

            # 每個 scale 層獨立去重
            cell_dict = defaultdict(list)   # key: (cx, cy) -> [(response, idx), ...]
            for idx, (x, y, sz, ang, octave, cid) in enumerate(kp_tuples_scale):
                cx = int(x) // DEDUP_GRID
                cy = int(y) // DEDUP_GRID
                cell_dict[(cx, cy)].append((sz, idx))   # sz 當作 response proxy

            keep_indices = []
            n_alpha_removed_scale = 0
            for (cx, cy), cell_pts in cell_dict.items():
                # 若原圖有 alpha 通道，檢查該格是否全透明
                if alpha is not None:
                    x0 = cx * DEDUP_GRID
                    y0 = cy * DEDUP_GRID
                    x1 = min(x0 + DEDUP_GRID, orig_w)
                    y1 = min(y0 + DEDUP_GRID, orig_h)
                    if x1 > x0 and y1 > y0 and alpha[y0:y1, x0:x1].max() == 0:
                        n_alpha_removed_scale += len(cell_pts)
                        continue

                # 每格取 size 最大的 MAX_PER_CELL 個
                cell_pts.sort(key=lambda v: -v[0])
                keep_indices.extend(idx for _, idx in cell_pts[:MAX_PER_CELL])

            keep_indices.sort()
            n_after_scale = len(keep_indices)
            total_alpha_removed += n_alpha_removed_scale

            if n_after_scale == 0:
                print(f'    -> dedup: 0 kept (removed {len(kp_tuples_scale)}, alpha-removed={n_alpha_removed_scale})')
                continue

            kp_tuples_kept = [kp_tuples_scale[i] for i in keep_indices]
            des_kept = des[keep_indices]
            all_kp_tuples.extend(kp_tuples_kept)
            all_des_list.append(des_kept)

            removed_scale = len(kp_tuples_scale) - n_after_scale
            alpha_info_scale = f', alpha-removed={n_alpha_removed_scale}' if alpha is not None else ''
            print(f'    -> dedup: {len(kp_tuples_scale)} -> {n_after_scale}  (grid={DEDUP_GRID}, max={MAX_PER_CELL}/cell, removed={removed_scale}{alpha_info_scale})')

        if not all_des_list:
            raise RuntimeError('No features extracted from base map!')

        n_raw        = len(all_kp_tuples)
        des_combined = np.vstack(all_des_list)   # shape (n_raw, 32), dtype uint8
        alpha_info = f', alpha-removed={total_alpha_removed}' if alpha is not None else ''
        print(f'[ORB] Total features after per-scale dedup + merge: {n_raw}  (removed {total_before_dedup - n_raw}{alpha_info})')

        # ── Binary format ──────────────────────────────────────────────────
        # Header:  magic(4B) + n(u32 LE)
        # Keypoints: n × 10B  →  x(u16) y(u16) size×10(u16) angle×100(u16) octave(u8) class_id(i8)
        # Descriptors: n × 32B (uint8)
        # Whole blob is gzip-compressed (level 9)
        header    = struct.pack('<4sI', b'ORBF', n_raw)
        kp_bytes  = bytearray(n_raw * 10)
        for i, (x, y, sz, ang, octave, cid) in enumerate(all_kp_tuples):
            struct.pack_into('<HHHHBb', kp_bytes, i * 10,
                min(65534, max(0, round(x))),
                min(65534, max(0, round(y))),
                min(65535, max(0, round(sz * 10))),
                0xFFFF if ang < 0 else min(35999, round(ang * 100)),
                octave,
                max(-128, min(127, cid)),
            )

        raw = header + bytes(kp_bytes) + des_combined.tobytes()
        with open(output_file, 'wb') as f:
            f.write(raw)

        print(f'[ORB] Saved → {output_file}  ({len(raw) / 1024:.0f} KB)')

    def load_features(self, feature_file):
        """從 .orbf 檔載入預萃取的特徵"""
        with open(feature_file, 'rb') as f:
            raw = f.read()

        magic, n = struct.unpack_from('<4sI', raw, 0)
        if magic != b'ORBF':
            raise ValueError(f'Invalid fingerprint file (magic={magic})')

        kp_end    = 8 + n * 10
        kp_block  = raw[8:kp_end]
        des_block = raw[kp_end:]

        self.kp_large = []
        for i in range(n):
            x, y, s10, a100, octave, cid = struct.unpack_from('<HHHHBb', kp_block, i * 10)
            self.kp_large.append(cv2.KeyPoint(
                x        = float(x),
                y        = float(y),
                size     = s10 / 10.0,
                angle    = -1.0 if a100 == 0xFFFF else a100 / 100.0,
                response = 0.0,
                octave   = int(octave),
                class_id = int(cid),
            ))

        self.des_large = np.frombuffer(des_block, dtype=np.uint8).reshape(n, 32)
        self.map_size  = (0, 0)   # not stored in this format (not needed for matching)
        print(f'[ORB] Loaded {n} keypoints from {feature_file}')

    # ─── Matching ─────────────────────────────────────────────────────────────

    def find_location(
        self,
        small_img_path,
        ratio_thresh  = 0.75,
        ransac_thresh = 5.0,
        min_good      = 6,
    ):
        """
        比對截圖與基底地圖，回傳：
          {
            'center':  (cx, cy),
            'corners': [(x,y), ...],   # 截圖四角在地圖上的座標
            'scale':   float,
            'inliers': int,
          }
          若失敗回傳 None
        """
        if self.kp_large is None or self.des_large is None:
            raise RuntimeError('No base map features loaded. Call load_features() first.')

        img_raw = cv2.imread(small_img_path, cv2.IMREAD_UNCHANGED)
        if img_raw is None:
            raise FileNotFoundError(f'Cannot load image: {small_img_path}')

        # 分離 alpha，轉灰階
        if img_raw.ndim == 2:
            img_small = img_raw
            mask_s    = None
        elif img_raw.shape[2] == 4:
            img_small = cv2.cvtColor(img_raw, cv2.COLOR_BGRA2GRAY)
            mask_s    = img_raw[:, :, 3]   # alpha 作為 mask（0=不偵測）
        else:
            img_small = cv2.cvtColor(img_raw, cv2.COLOR_BGR2GRAY)
            mask_s    = None

        kp_s, des_s = self.orb.detectAndCompute(img_small, mask_s)
        n_kp = len(kp_s) if kp_s else 0
        alpha_info = ' [alpha mask]' if mask_s is not None else ''
        print(f'[ORB] Template keypoints: {n_kp}{alpha_info}')
        if des_s is None or n_kp < min_good:
            print(f'[ORB] Not enough keypoints (min={min_good})')
            return None

        matches = self.bf.knnMatch(des_s, self.des_large, k=2)
        good    = [m for m, n in matches if m.distance < ratio_thresh * n.distance]
        print(f'[ORB] Good matches: {len(good)} / {len(matches)}')

        if len(good) < min_good:
            print(f'[ORB] Not enough good matches (min={min_good})')
            return None

        src_pts = np.float32([kp_s[m.queryIdx].pt          for m in good]).reshape(-1, 1, 2)
        dst_pts = np.float32([self.kp_large[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)

        M, mask = cv2.estimateAffinePartial2D(
            src_pts, dst_pts,
            method=cv2.RANSAC,
            ransacReprojThreshold=ransac_thresh,
        )

        if M is None:
            print('[ORB] RANSAC failed to find affine transform')
            return None

        inliers = int(mask.sum())
        print(f'[ORB] RANSAC inliers: {inliers} / {len(good)}')

        h, w        = img_small.shape
        corners_src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
        corners_dst = cv2.transform(corners_src.reshape(-1, 1, 2), M).reshape(-1, 2)
        corners_int = [(int(p[0]), int(p[1])) for p in corners_dst]

        center = (
            int(np.mean([p[0] for p in corners_int])),
            int(np.mean([p[1] for p in corners_int])),
        )

        # 從仿射矩陣取得縮放比例（行列式平方根）
        scale = float(np.sqrt(abs(np.linalg.det(M[:, :2]))))

        return {
            'center':  center,
            'corners': corners_int,
            'scale':   round(scale, 4),
            'inliers': inliers,
        }

    # ─── Visualization ────────────────────────────────────────────────────────

    def visualize(self, base_img_path, small_img_path, result, output_path=None):
        """在基底地圖上畫出截圖對應的框線，並排顯示截圖與地圖放大區域"""
        if result is None:
            print('[ORB] No result to visualize')
            return None

        base  = cv2.imread(base_img_path)
        small = cv2.imread(small_img_path)
        if base is None or small is None:
            raise FileNotFoundError('Cannot load images for visualization')

        # 在地圖上畫多邊形框
        pts   = np.array(result['corners'], dtype=np.int32)
        thick = max(3, base.shape[1] // 800)
        cv2.polylines(base, [pts], isClosed=True, color=(0, 255, 0), thickness=thick)

        cx, cy = result['center']
        dot_r  = max(8, base.shape[1] // 600)
        cv2.circle(base, (cx, cy), dot_r, (0, 0, 255), -1)

        label      = f"scale={result['scale']:.2f}  inliers={result['inliers']}"
        font_scale = max(0.8, base.shape[1] / 3000)
        cv2.putText(base, label, (cx + dot_r + 4, cy - dot_r - 4),
                    cv2.FONT_HERSHEY_SIMPLEX, font_scale, (0, 255, 255), max(2, thick - 1))

        # 裁切地圖上匹配的區域（加 20% 邊距）
        x_vals = [p[0] for p in result['corners']]
        y_vals = [p[1] for p in result['corners']]
        x1, x2 = max(0, min(x_vals)), min(base.shape[1], max(x_vals))
        y1, y2 = max(0, min(y_vals)), min(base.shape[0], max(y_vals))
        pad_x  = max(30, int((x2 - x1) * 0.2))
        pad_y  = max(30, int((y2 - y1) * 0.2))
        crop   = base[max(0, y1 - pad_y):min(base.shape[0], y2 + pad_y),
                      max(0, x1 - pad_x):min(base.shape[1], x2 + pad_x)].copy()

        # 截圖縮放到和裁切區域相同高度
        target_h      = crop.shape[0]
        ratio         = target_h / small.shape[0]
        resized_small = cv2.resize(small, (max(1, int(small.shape[1] * ratio)), target_h))

        # 拼排：截圖 ▏ 地圖放大區
        divider = np.full((target_h, 6, 3), (80, 200, 80), dtype=np.uint8)
        panel   = np.hstack([resized_small, divider, crop])

        if output_path:
            cv2.imwrite(output_path, panel)
            print(f'[ORB] Visualization saved → {output_path}')
        else:
            cv2.imshow('ORB Match Result', panel)
            cv2.waitKey(0)
            cv2.destroyAllWindows()

        return panel


# ─── CLI ──────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    BASE_IMG  = 'map02.webp'
    ORBF_FILE = 'map02.orbf'
    TEST_IMG  = r'D:\Downloads\endFieldMapTest2.png'
    OUT_IMG   = 'orb_result.png'

    matcher = MapMatcher()

    # --extract 旗標：強制重新萃取（或 .orbf 不存在時自動萃取）
    if '--extract' in sys.argv or not os.path.exists(ORBF_FILE):
        matcher.extract_and_save(BASE_IMG, ORBF_FILE)

    matcher.load_features(ORBF_FILE)

    # --match <path> 旗標：指定截圖路徑
    match_img = TEST_IMG
    if '--match' in sys.argv:
        idx = sys.argv.index('--match')
        if idx + 1 < len(sys.argv):
            match_img = sys.argv[idx + 1]

    print(f'\n[ORB] Matching: {match_img}')
    result = matcher.find_location(match_img)

    if result:
        print(f'\n✅ Match found!')
        print(f'   Center:  {result["center"]}')
        print(f'   Corners: {result["corners"]}')
        print(f'   Scale:   {result["scale"]}')
        print(f'   Inliers: {result["inliers"]}')
        matcher.visualize(BASE_IMG, match_img, result, output_path=OUT_IMG)
    else:
        print('\n❌ Match not found.')
        sys.exit(1)
