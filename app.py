"""本地 PDF 拆分 / 合并工具。

运行: python app.py
或双击 启动.bat
"""

from __future__ import annotations

import os
import re
import shutil
import socket
import sys
import threading
import time
import traceback
import uuid
import webbrowser
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import quote

try:
    import pymupdf
    from fastapi import FastAPI, File, HTTPException, UploadFile
    from fastapi.responses import FileResponse, HTMLResponse
    from fastapi.staticfiles import StaticFiles
    from pydantic import BaseModel
    from pypdf import PdfReader, PdfWriter
except ImportError:
    print("缺少依赖，请在此目录运行: python -m pip install -r requirements.txt")
    raise SystemExit(1)

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
TMP = ROOT / ".tmp"
PORT = 8765
MAX_FILE_BYTES = 300 * 1024 * 1024
MAX_TOTAL_BYTES = 800 * 1024 * 1024
MAX_FILES = 30
MAX_PAGES = 2000
JOB_TTL_SECONDS = 6 * 3600
INVALID_CHARS = set('\\/:*?"<>|')
RESERVED_NAMES = {"CON", "PRN", "AUX", "NUL"}
RESERVED_PATTERN = re.compile(r"(COM|LPT)[1-9]$")


@dataclass
class Source:
    name: str
    path: Path
    count: int


@dataclass
class Page:
    id: int
    source_index: int
    page_index: int
    file: str
    page: int


@dataclass
class Job:
    id: str
    directory: Path
    sources: list[Source] = field(default_factory=list)
    pages: list[Page] = field(default_factory=list)
    next_id: int = 1
    created: float = field(default_factory=time.time)


class ExportRequest(BaseModel):
    page_ids: list[int]
    filename: str


jobs: dict[str, Job] = {}
jobs_lock = threading.Lock()
render_slots = threading.Semaphore(3)


def fail(status: int, message: str) -> None:
    raise HTTPException(status_code=status, detail=message)


def remove_file(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


def clean_display_name(name: str | None) -> str:
    base = Path((name or "").replace("\x00", "")).name.strip()
    if not base or base in {".", ".."}:
        return "未命名.pdf"
    return base


def clean_stem(raw: str) -> str:
    stem = (raw or "").replace("\x00", "").strip()
    if stem.lower().endswith(".pdf"):
        stem = stem[:-4].strip()
    stem = stem.rstrip(". ").strip()
    if not stem:
        raise ValueError("请填写文件名")
    if len(stem) > 180:
        raise ValueError("文件名过长")
    if any(char in INVALID_CHARS or ord(char) < 32 for char in stem):
        raise ValueError('文件名不能包含 \\ / : * ? " < > |')
    upper = stem.upper()
    if upper in RESERVED_NAMES or RESERVED_PATTERN.fullmatch(upper):
        raise ValueError("该文件名不可用")
    return stem


def public_pages(job: Job) -> list[dict[str, object]]:
    return [{"id": page.id, "file": page.file, "page": page.page} for page in job.pages]


def reset_tmp() -> None:
    if TMP.exists():
        shutil.rmtree(TMP, ignore_errors=True)
    TMP.mkdir(parents=True, exist_ok=True)


def sweep_unlocked() -> None:
    now = time.time()
    expired = [job_id for job_id, job in jobs.items() if now - job.created > JOB_TTL_SECONDS]
    for job_id in expired:
        job = jobs.pop(job_id, None)
        if job:
            shutil.rmtree(job.directory, ignore_errors=True)


def require_dependencies() -> None:
    try:
        __import__("uvicorn")
        __import__("multipart")
    except ImportError:
        print("缺少依赖，请在此目录运行: python -m pip install -r requirements.txt")
        raise SystemExit(1)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    reset_tmp()
    yield
    shutil.rmtree(TMP, ignore_errors=True)


app = FastAPI(title="PDF 处理", docs_url=None, redoc_url=None, lifespan=lifespan)


def inspect_pdf(path: Path, name: str) -> int:
    with path.open("rb") as handle:
        head = handle.read(1024)
    if b"%PDF" not in head:
        raise ValueError(f"「{name}」不是 PDF 文件")
    document = None
    try:
        document = pymupdf.open(path)
        if document.needs_pass:
            raise ValueError(f"「{name}」已加密，无法处理")
        if document.page_count < 1:
            raise ValueError(f"「{name}」没有页面")
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError(f"「{name}」无法读取，文件可能已损坏") from exc
    finally:
        if document is not None:
            document.close()
    reader = None
    try:
        reader = PdfReader(str(path))
        if reader.is_encrypted and reader.decrypt("") == 0:
            raise ValueError(f"「{name}」已加密，无法处理")
        count = len(reader.pages)
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError(f"「{name}」无法读取，文件可能已损坏") from exc
    finally:
        close = getattr(reader, "close", None)
        if callable(close):
            close()
    if count < 1:
        raise ValueError(f"「{name}」没有页面")
    return count


async def save_upload(upload: UploadFile, dest: Path, display_name: str) -> int:
    size = 0
    try:
        with dest.open("wb") as handle:
            while True:
                chunk = await upload.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_FILE_BYTES:
                    raise ValueError(f"「{display_name}」超过 300MB，无法处理")
                handle.write(chunk)
        if size == 0:
            raise ValueError(f"「{display_name}」是空文件")
        return size
    except Exception:
        remove_file(dest)
        raise
    finally:
        await upload.close()


def attach_sources(job: Job, staged: list[tuple[str, Path, int]]) -> None:
    extra = sum(count for _name, _path, count in staged)
    if len(job.pages) + extra > MAX_PAGES:
        raise ValueError(f"页面总数不能超过 {MAX_PAGES} 页")
    for name, path, count in staged:
        source_index = len(job.sources)
        job.sources.append(Source(name, path, count))
        for index in range(count):
            job.pages.append(Page(job.next_id, source_index, index, name, index + 1))
            job.next_id += 1


async def stage_uploads(job: Job, files: list[UploadFile]) -> list[tuple[str, Path, int]]:
    if not files:
        raise ValueError("请选择 PDF 文件")
    if len(files) > MAX_FILES:
        raise ValueError(f"一次最多添加 {MAX_FILES} 个文件")
    staged: list[tuple[str, Path, int]] = []
    total = 0
    try:
        for upload in files:
            name = clean_display_name(upload.filename)
            source_index = len(job.sources) + len(staged)
            path = job.directory / f"src-{source_index:03d}.pdf"
            size = await save_upload(upload, path, name)
            total += size
            if total > MAX_TOTAL_BYTES:
                raise ValueError("添加的文件合计超过 800MB")
            try:
                count = inspect_pdf(path, name)
            except Exception:
                remove_file(path)
                raise
            staged.append((name, path, count))
        return staged
    except Exception:
        for _name, path, _count in staged:
            remove_file(path)
        raise


def new_job() -> Job:
    job_id = uuid.uuid4().hex
    directory = TMP / job_id
    directory.mkdir(parents=True, exist_ok=True)
    return Job(id=job_id, directory=directory)


def discard_job_dir(job: Job) -> None:
    shutil.rmtree(job.directory, ignore_errors=True)


@app.get("/")
def index() -> HTMLResponse:
    html = (STATIC / "index.html").read_text(encoding="utf-8")
    version = str(int((STATIC / "app.js").stat().st_mtime))
    return HTMLResponse(html.replace("{{v}}", version), headers={"Cache-Control": "no-cache"})


@app.post("/api/jobs")
async def create_job(files: list[UploadFile] = File(...)) -> dict[str, object]:
    job = new_job()
    try:
        staged = await stage_uploads(job, files)
        attach_sources(job, staged)
    except ValueError as exc:
        discard_job_dir(job)
        fail(400, str(exc))
    except HTTPException:
        discard_job_dir(job)
        raise
    except Exception:
        discard_job_dir(job)
        traceback.print_exc()
        fail(500, "处理失败")
    with jobs_lock:
        sweep_unlocked()
        jobs[job.id] = job
    return {"id": job.id, "pages": public_pages(job)}


@app.post("/api/jobs/{job_id}/files")
async def append_files(job_id: str, files: list[UploadFile] = File(...)) -> dict[str, object]:
    with jobs_lock:
        job = jobs.get(job_id)
    if job is None:
        fail(404, "任务不存在或已清空")
    staged: list[tuple[str, Path, int]] = []
    try:
        staged = await stage_uploads(job, files)
        with jobs_lock:
            current = jobs.get(job_id)
            if current is None:
                raise ValueError("任务不存在或已清空")
            attach_sources(current, staged)
            return {"id": current.id, "pages": public_pages(current)}
    except ValueError as exc:
        for _name, path, _count in staged:
            remove_file(path)
        fail(400, str(exc))
    except HTTPException:
        raise
    except Exception:
        for _name, path, _count in staged:
            remove_file(path)
        traceback.print_exc()
        fail(500, "处理失败")


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str) -> dict[str, bool]:
    with jobs_lock:
        job = jobs.pop(job_id, None)
    if job:
        shutil.rmtree(job.directory, ignore_errors=True)
    return {"ok": True}


def snapshot_page(job_id: str, page_id: int) -> tuple[Path, Path, int]:
    with jobs_lock:
        job = jobs.get(job_id)
        if job is None:
            fail(404, "任务不存在或已清空")
        page = next((item for item in job.pages if item.id == page_id), None)
        if page is None:
            fail(404, "页面不存在")
        source = job.sources[page.source_index]
        return source.path, job.directory, page.page_index


def render_jpeg(pdf_path: Path, page_index: int, dest: Path, max_width: int, quality: int) -> None:
    document = pymupdf.open(pdf_path)
    partial = dest.with_name(f"{dest.stem}.{uuid.uuid4().hex}.part")
    try:
        if page_index < 0 or page_index >= document.page_count:
            raise ValueError("页面不存在")
        page = document[page_index]
        width = float(page.rect.width) or 1.0
        scale = min(3.0, max_width / width)
        pixmap = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
        partial.write_bytes(pixmap.tobytes("jpeg", jpg_quality=quality))
        partial.replace(dest)
    finally:
        document.close()
        partial.unlink(missing_ok=True)


def image_response(job_id: str, page_id: int, kind: str, max_width: int, quality: int) -> FileResponse:
    pdf_path, directory, page_index = snapshot_page(job_id, page_id)
    dest = directory / f"{kind}-{page_id}.jpg"
    if not (dest.exists() and dest.stat().st_size > 0):
        with render_slots:
            if not (dest.exists() and dest.stat().st_size > 0):
                try:
                    render_jpeg(pdf_path, page_index, dest, max_width, quality)
                except HTTPException:
                    raise
                except Exception:
                    traceback.print_exc()
                    fail(500, "预览生成失败")
    return FileResponse(
        dest,
        media_type="image/jpeg",
        headers={"Cache-Control": "private, max-age=3600"},
    )


@app.get("/api/jobs/{job_id}/pages/{page_id}/thumb")
def page_thumb(job_id: str, page_id: int) -> FileResponse:
    return image_response(job_id, page_id, "thumb", 400, 80)


@app.get("/api/jobs/{job_id}/pages/{page_id}/preview")
def page_preview(job_id: str, page_id: int) -> FileResponse:
    return image_response(job_id, page_id, "preview", 1400, 86)


@app.post("/api/jobs/{job_id}/export")
def export_pdf(job_id: str, body: ExportRequest) -> FileResponse:
    try:
        stem = clean_stem(body.filename)
    except ValueError as exc:
        fail(400, str(exc))
    if not body.page_ids:
        fail(400, "请至少选择一页")
    if len(body.page_ids) != len(set(body.page_ids)):
        fail(400, "页面选择无效")
    with jobs_lock:
        job = jobs.get(job_id)
        if job is None:
            fail(404, "任务不存在或已清空")
        selected: list[tuple[Path, int]] = []
        page_map = {page.id: page for page in job.pages}
        for page_id in body.page_ids:
            page = page_map.get(page_id)
            if page is None:
                fail(400, "包含无效页面")
            selected.append((job.sources[page.source_index].path, page.page_index))
        output = job.directory / f"export-{uuid.uuid4().hex}.pdf"
    readers: dict[str, PdfReader] = {}
    writer = PdfWriter()
    try:
        for path, page_index in selected:
            key = str(path)
            if key not in readers:
                readers[key] = PdfReader(key)
            writer.add_page(readers[key].pages[page_index])
        with output.open("wb") as handle:
            writer.write(handle)
    except HTTPException:
        raise
    except Exception:
        traceback.print_exc()
        remove_file(output)
        fail(500, "生成失败")
    finally:
        for reader in readers.values():
            close = getattr(reader, "close", None)
            if callable(close):
                close()
    download_name = f"{stem}.pdf"
    headers = {
        "Content-Disposition": f"attachment; filename=\"download.pdf\"; filename*=UTF-8''{quote(download_name)}",
        "Cache-Control": "no-store",
    }
    return FileResponse(output, media_type="application/pdf", headers=headers)


app.mount("/static", StaticFiles(directory=STATIC), name="static")


def port_is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def main() -> None:
    require_dependencies()
    if not port_is_free(PORT):
        print(f"端口 {PORT} 已被占用，请先关闭已打开的 PDF 处理窗口。")
        raise SystemExit(1)
    url = f"http://127.0.0.1:{PORT}"
    if os.environ.get("PDF_TOOL_NO_BROWSER") != "1":
        threading.Timer(0.7, lambda: webbrowser.open(url)).start()
    print(f"PDF 处理已启动：{url}", flush=True)
    print("关闭此窗口即停止服务。", flush=True)
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info", access_log=False)


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    main()
