#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把用户提供的文件（PDF/Word/Excel/PPT/文本/网页等）提取成可汇总的文本。

只读输入、只写 --out 指定的目录；不联网。
输出：
  extracted/<原文件名>.txt   每个文件的纯文本（含基本信息头）
  files.json                 提取结果清单（路径、字数、页数、是否成功、错误）
  all-in-one.md              把所有成功提取的文本拼成一份，便于直接预览/送给 AI
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

TEXT_EXTS = {".txt", ".md", ".markdown", ".log", ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml",
             ".xml", ".ini", ".cfg", ".conf", ".py", ".js", ".ts", ".mjs", ".cjs", ".java", ".go",
             ".rs", ".c", ".h", ".cpp", ".cs", ".php", ".rb", ".sh", ".ps1", ".bat", ".sql", ".html",
             ".htm", ".vue", ".jsx", ".tsx", ".toml"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff"}
MAX_CHARS_PER_FILE = 400_000


def extract_pdf(path: Path) -> dict[str, Any]:
    from pypdf import PdfReader
    reader = PdfReader(str(path))
    pages = []
    empty_pages = 0
    for index, page in enumerate(reader.pages, 1):
        try:
            text = page.extract_text() or ""
        except Exception as exc:  # noqa: BLE001
            text = ""
            pages.append(f"（第 {index} 页解析失败：{exc}）")
            continue
        if text.strip():
            pages.append(f"\n--- 第 {index} 页 ---\n{text.strip()}")
        else:
            empty_pages += 1
    body = "\n".join(pages).strip()
    return {
        "text": body,
        "meta": {"pages": len(reader.pages), "empty_pages": empty_pages,
                 "scanned_likely": bool(reader.pages) and empty_pages >= max(1, int(len(reader.pages) * 0.8))},
    }


def extract_docx(path: Path) -> dict[str, Any]:
    from docx import Document
    document = Document(str(path))
    parts = [p.text.strip() for p in document.paragraphs if p.text and p.text.strip()]
    for table in document.tables:
        for row in table.rows:
            cells = [cell.text.strip() for cell in row.cells if cell.text and cell.text.strip()]
            if cells:
                parts.append(" | ".join(cells))
    return {"text": "\n".join(parts), "meta": {"paragraphs": len(document.paragraphs), "tables": len(document.tables)}}


def extract_pptx(path: Path) -> dict[str, Any]:
    try:
        from pptx import Presentation  # type: ignore
    except ImportError as exc:
        raise RuntimeError("未安装 python-pptx，无法解析 pptx") from exc
    presentation = Presentation(str(path))
    parts = []
    for index, slide in enumerate(presentation.slides, 1):
        texts = [shape.text.strip() for shape in slide.shapes if hasattr(shape, "text") and shape.text and shape.text.strip()]
        if texts:
            parts.append(f"\n--- 第 {index} 页 ---\n" + "\n".join(texts))
    return {"text": "\n".join(parts), "meta": {"slides": len(presentation.slides)}}


def extract_excel(path: Path) -> dict[str, Any]:
    import pandas as pd
    sheets = pd.read_excel(path, sheet_name=None, dtype=str)
    parts = []
    for name, frame in sheets.items():
        frame = frame.fillna("")
        head = frame.head(200)
        parts.append(f"\n--- 工作表：{name}（{len(frame)} 行 × {len(frame.columns)} 列，最多展示前 200 行）---\n")
        parts.append(head.to_csv(index=False, sep="\t"))
    return {"text": "\n".join(parts), "meta": {"sheets": list(sheets.keys())}}


def extract_html(path: Path) -> dict[str, Any]:
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(path.read_text(encoding="utf-8", errors="replace"), "html.parser")
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()
    title = soup.title.string.strip() if soup.title and soup.title.string else ""
    return {"text": soup.get_text("\n", strip=True), "meta": {"title": title}}


def extract_text(path: Path) -> dict[str, Any]:
    raw = path.read_text(encoding="utf-8", errors="replace")
    return {"text": raw, "meta": {"bytes": path.stat().st_size}}


def extract_image(path: Path) -> dict[str, Any]:
    from PIL import Image
    with Image.open(path) as image:
        return {"text": "", "meta": {"width": image.width, "height": image.height,
                                     "note": "图片不提取文字；汇总时由支持视觉的模型直接查看原图"}}
def extract_file(path: Path) -> dict[str, Any]:
    ext = path.suffix.lower()
    if ext == ".pdf":
        return extract_pdf(path)
    if ext in (".docx", ".doc"):
        return extract_docx(path)
    if ext == ".pptx":
        return extract_pptx(path)
    if ext in (".xlsx", ".xls", ".xlsm"):
        return extract_excel(path)
    if ext in (".html", ".htm"):
        return extract_html(path)
    if ext in IMAGE_EXTS:
        return extract_image(path)
    if ext in TEXT_EXTS:
        return extract_text(path)
    # 未知类型：先按文本尝试，失败则报错
    try:
        return extract_text(path)
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"不支持的文件类型 {ext or '(无扩展名)'}：{exc}") from exc


def main() -> int:
    parser = argparse.ArgumentParser(description="提取用户提供的文件文本（PDF/Word/Excel/文本等）")
    parser.add_argument("--src", required=True, help="文件或目录")
    parser.add_argument("--out", required=True, help="输出目录")
    parser.add_argument("--max-chars", type=int, default=MAX_CHARS_PER_FILE, help="单文件最多保留字符数")
    args = parser.parse_args()

    src = Path(args.src).expanduser()
    out = Path(args.out).expanduser()
    (out / "extracted").mkdir(parents=True, exist_ok=True)

    if src.is_file():
        files = [src]
    else:
        skip = {".git", "node_modules", "__pycache__", ".venv"}
        files = sorted(p for p in src.rglob("*")
                       if p.is_file() and not any(part in skip for part in p.parts) and not p.name.startswith("."))

    results: list[dict[str, Any]] = []
    combined: list[str] = []
    for path in files:
        entry: dict[str, Any] = {"file": str(path), "name": path.name, "ext": path.suffix.lower(),
                                 "sizeKB": round(path.stat().st_size / 1024, 1)}
        try:
            data = extract_file(path)
            text = (data.get("text") or "").strip()
            truncated = len(text) > args.max_chars
            if truncated:
                text = text[:args.max_chars] + f"\n…（超出 {args.max_chars} 字符已截断）"
            entry.update({"ok": True, "chars": len(text), "truncated": truncated})
            entry.update(data.get("meta") or {})
            target = out / "extracted" / f"{path.stem}.txt"
            header = (f"# 来源：{path.name}\n# 类型：{entry['ext'] or '未知'}｜大小：{entry['sizeKB']} KB"
                      f"｜提取字数：{entry['chars']}\n# 导出时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n")
            target.write_text(header + text, encoding="utf-8")
            entry["extractedTo"] = str(target)
            entry["preview"] = text[:200].replace("\n", " ")
            if text:
                combined.append(f"\n\n<!-- ===== {path.name} ===== -->\n{text}")
            if entry.get("scanned_likely"):
                entry["warning"] = "PDF 大部分页面没有文字层，可能是扫描件：需要 OCR 或让支持视觉的模型看图"
        except Exception as exc:  # noqa: BLE001
            entry.update({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
        results.append(entry)

    ok = [item for item in results if item.get("ok")]
    (out / "files.json").write_text(json.dumps({"generatedAt": datetime.now().isoformat(timespec="seconds"),
                                                "total": len(results), "ok": len(ok), "files": results},
                                               ensure_ascii=False, indent=2), encoding="utf-8")
    (out / "all-in-one.md").write_text(
        f"# 用户提供文件汇总材料\n\n共 {len(ok)}/{len(results)} 个文件成功提取。\n" + "".join(combined),
        encoding="utf-8")

    print(json.dumps({"total": len(results), "ok": len(ok),
                      "failed": [item["name"] for item in results if not item.get("ok")],
                      "out": str(out)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
