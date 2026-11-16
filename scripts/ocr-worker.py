#!/usr/bin/env python3
"""Optional OCR worker using the user's shared, isolated RapidOCR runtime."""
from __future__ import annotations

import json
from pathlib import Path
import re
import sys

def collect(directory: Path) -> list[Path]:
    if not directory.is_dir():
        raise RuntimeError(f"Missing image directory: {directory}")
    result = []
    for p in directory.iterdir():
        match = re.fullmatch(r"(\d{1,4})\.(jpg|jpeg|png|gif|webp)", p.name, re.I)
        if match and p.is_file() and p.stat().st_size > 0:
            result.append((int(match.group(1)), p))
    result.sort()
    if not result:
        raise RuntimeError(f"No numbered images in {directory}")
    if [n for n, _ in result] != list(range(1, len(result) + 1)):
        raise RuntimeError(f"Missing or duplicate image number in {directory}")
    return [p for _, p in result]

def run_ocr(engine, file: Path) -> list[str]:
    source: object = str(file)
    if file.suffix.lower() == ".gif":
        from PIL import Image
        import numpy as np
        with Image.open(file) as frame:
            frame.seek(0)
            source = np.asarray(frame.convert("RGB"))
    rows, _ = engine(source)
    out = []
    for row in rows or []:
        if len(row) >= 3 and isinstance(row[1], str) and row[1].strip():
            out.append(row[1].strip())
    return out

def main() -> int:
    if len(sys.argv) != 3:
        raise RuntimeError("Usage: ocr-worker.py <product output directory> <product id>")
    root = Path(sys.argv[1]).resolve()
    product_id = sys.argv[2]
    if not re.fullmatch(r"\d{8,16}", product_id):
        raise RuntimeError("Invalid product ID")
    from rapidocr_onnxruntime import RapidOCR
    engine = RapidOCR()
    categories = [("main", "主图"), ("detail", "详情页")]
    pending = []
    for category, title in categories:
        files = collect(root / category)
        dest = root / f"{product_id}-{title}文案.txt"
        if dest.exists():
            raise RuntimeError(f"Existing OCR text; refuse to overwrite: {dest}")
        lines = [
            f"商品：{product_id}", f"类别：{title}",
            "说明：本地 OCR 自动识别初稿，未经人工逐字核对", ""
        ]
        detected = 0
        for file in files:
            words = run_ocr(engine, file)
            detected += len(words)
            lines.extend([f"【{file.name}】", *words] if words else [f"【{file.name}】", "（未识别到文字）"])
            lines.append("")
        pending.append((dest, "\n".join(lines).rstrip() + "\n", len(files), detected))
    # Perform all inference before writing either of the two deliverables.
    for dest, content, _, _ in pending:
        with dest.open("x", encoding="utf-8", newline="\n") as output:
            output.write(content)
    print(json.dumps({
        "status": "ocr_complete", "productId": product_id,
        "outputs": [{"path": str(p), "images": n, "lines": count} for p, _, n, count in pending],
        "humanVerified": False
    }, ensure_ascii=False))
    return 0

if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(json.dumps({"status": "ocr_failed", "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(2)
