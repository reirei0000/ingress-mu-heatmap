#!/usr/bin/env python3
"""全世界の S2 Level 13 詳細データファイル (s2map/data/l13/<l6_token>.json) を高速並列生成するスクリプト.

すでに生成済みの Level-6 密度テーブル (density-l6-*.npy) を利用して、
人口が 0 の海洋・無人リージョン (約17,700個) をスキップし、
人口が存在する約 6,842 個の Level-6 リージョンだけをマルチプロセス (NumPy ベクトル演算 + 4方向ヒルベルト変換テーブル) で約1分で計算します。
"""

import concurrent.futures
import json
import multiprocessing
import os
from pathlib import Path
import sys
import time
import numpy as np
import s2sphere

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from mu_calculator import tables
from mu_calculator.geometry import Grump, l15_centres

GRUMP_DATA = Path(os.environ.get("GRUMP_DATA", REPO_ROOT / "mu_calculator/data/grump"))
BIL_DIR = GRUMP_DATA / "bil"
OUT_DIR = Path(__file__).resolve().parent / "data"
L13_DIR = OUT_DIR / "l13"

_grump = None
_HILBERT_IA = {}
_HILBERT_JB = {}


def _init_worker(bil_folder):
    global _grump, _HILBERT_IA, _HILBERT_JB
    _grump = Grump(bil_folder)
    shift = 30 - 13
    base = 1 << (30 - 6)
    for idx in range(100):
        parent = s2sphere.CellId((2 * idx + 1) << 48)
        _, i, j, o = parent.to_face_ij_orientation()
        if o not in _HILBERT_IA:
            i0, j0 = i // base * base, j // base * base
            ia_list, jb_list = [], []
            for child in parent.children(13):
                _, ci, cj, _ = child.to_face_ij_orientation()
                ia_list.append((ci - i0) >> shift)
                jb_list.append((cj - j0) >> shift)
            _HILBERT_IA[o] = np.array(ia_list, dtype=np.int32)
            _HILBERT_JB[o] = np.array(jb_list, dtype=np.int32)
        if len(_HILBERT_IA) == 4:
            break


def _build_l13_region(l6_index):
    cid = (2 * int(l6_index) + 1) << 48
    parent = s2sphere.CellId(cid)
    token = parent.to_token()

    samples = _grump.sample(*l15_centres(cid)).reshape(512, 512)
    means = tables.repack(samples, 13)  # shape (128, 128)
    _, _, _, o = parent.to_face_ij_orientation()

    ordered = means[_HILBERT_IA[o], _HILBERT_JB[o]].astype(np.float32)
    nz = np.flatnonzero(ordered > 0)
    if len(nz) == 0:
        return None

    sub_indices = nz.tolist()
    sub_densities = ordered[nz].tolist()

    payload = {
        "region": token,
        "l6_index": int(l6_index),
        "count": len(sub_indices),
        "idx": sub_indices,
        "val": sub_densities,
    }
    out_file = L13_DIR / f"{token}.json"
    out_file.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    return token, len(sub_indices)


def main():
    L13_DIR.mkdir(parents=True, exist_ok=True)
    l6_table = tables.load_table(BIL_DIR, level=6)
    if l6_table is None:
        raise RuntimeError("先に Level 6 テーブル (build-tables) を生成してください。")

    nonzero_l6 = [int(i) for i in np.flatnonzero(l6_table > 0)]
    workers = min(14, os.cpu_count() or 4)
    print(f"全世界 24,576 リージョン中、人口が存在する {len(nonzero_l6)} リージョンの Level 13 データを {workers} ワーカーで生成します...", flush=True)

    t0 = time.monotonic()
    total_cells = 0
    generated_tokens = []

    with concurrent.futures.ProcessPoolExecutor(
        max_workers=workers,
        mp_context=multiprocessing.get_context("spawn"),
        initializer=_init_worker,
        initargs=(str(BIL_DIR),),
    ) as pool:
        futures = [pool.submit(_build_l13_region, idx) for idx in nonzero_l6]
        done = 0
        for fut in concurrent.futures.as_completed(futures):
            res = fut.result()
            done += 1
            if res is not None:
                token, cnt = res
                generated_tokens.append(token)
                total_cells += cnt
            if done % 500 == 0 or done == len(nonzero_l6):
                elapsed = time.monotonic() - t0
                print(
                    f"  進捗: {done}/{len(nonzero_l6)} リージョン完了 "
                    f"(有効ファイル: {len(generated_tokens)}, 累計L13セル: {total_cells:,}, {elapsed:.1f}秒)",
                    flush=True,
                )

    generated_tokens.sort()

    world_path = OUT_DIR / "world.json"
    world_data = json.loads(world_path.read_text(encoding="utf-8"))
    world_data["l13_regions"] = generated_tokens
    world_path.write_text(json.dumps(world_data, separators=(",", ":")), encoding="utf-8")

    elapsed = time.monotonic() - t0
    print("=" * 60)
    print(f"全世界 Level 13 データ生成完了！ ({elapsed:.1f} 秒)")
    print(f"  生成リージョンファイル数 : {len(generated_tokens):,} 個")
    print(f"  全世界の有効 L13 セル数  : {total_cells:,} 個")
    print("=" * 60)


if __name__ == "__main__":
    main()
