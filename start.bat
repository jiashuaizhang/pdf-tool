@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" python -m venv .venv
".venv\Scripts\python.exe" -c "import fastapi,uvicorn,pymupdf,pypdf,multipart" 2>nul
if errorlevel 1 ".venv\Scripts\python.exe" -m pip install -r requirements.txt
".venv\Scripts\python.exe" app.py
if errorlevel 1 pause
