"""Companion — AWS Lambda packaging script (BackEnd Epic: deployable zip).

Builds `backend/lambda_package.zip`, a self-contained deployment artifact for
AWS Lambda (Python 3.12, Amazon Linux / x86_64):

  1. Clean any previous build/ dir and lambda_package.zip.
  2. Install requirements.txt into build/ using manylinux2014_x86_64 wheels so
     native deps (psycopg2-binary) match Lambda's runtime.
  3. Copy lambda_handler.py and the prompts/ directory into build/.
  4. Zip the build/ contents at the archive root and remove build/.
  5. Report the final size and key contents.

Run:  python backend/package_lambda.py
"""

import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent
BUILD_DIR = BACKEND_DIR / "build"
ZIP_PATH = BACKEND_DIR / "lambda_package.zip"
REQUIREMENTS = BACKEND_DIR / "requirements.txt"
PROMPTS_DIR = BACKEND_DIR / "prompts"
# Python sources copied verbatim into the package root.
SOURCE_FILES = ["lambda_handler.py", "app.py", "insights.py", "intent.py", "reports.py"]
# Startup script (Lambda Handler for the LWA .zip deployment); needs +x.
RUN_SCRIPT = "run.sh"

# Target Lambda's Amazon Linux x86_64 / Python 3.12 environment.
PIP_PLATFORM = "manylinux2014_x86_64"
PYTHON_VERSION = "3.12"


def clean():
    """Remove artifacts from any previous build."""
    if BUILD_DIR.exists():
        print(f"Cleaning previous build dir: {BUILD_DIR}")
        shutil.rmtree(BUILD_DIR)
    if ZIP_PATH.exists():
        print(f"Removing previous zip: {ZIP_PATH}")
        ZIP_PATH.unlink()


def install_dependencies():
    """Install requirements into build/ using Lambda-compatible wheels."""
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    cmd = [
        sys.executable, "-m", "pip", "install",
        "--platform", PIP_PLATFORM,
        "--target", str(BUILD_DIR),
        "--implementation", "cp",
        "--python-version", PYTHON_VERSION,
        "--only-binary=:all:",
        "--upgrade",
        "-r", str(REQUIREMENTS),
    ]
    print("Installing dependencies for Lambda runtime:\n  " + " ".join(cmd))
    subprocess.run(cmd, check=True)


def copy_sources():
    """Copy source files, the startup script, and prompt templates into build/."""
    for name in SOURCE_FILES:
        print(f"Copying source: {name}")
        shutil.copy2(BACKEND_DIR / name, BUILD_DIR / name)

    # Startup script must be executable in the package (Lambda Handler = run.sh).
    dest_run = BUILD_DIR / RUN_SCRIPT
    print(f"Copying startup script: {RUN_SCRIPT} (chmod +x)")
    shutil.copy2(BACKEND_DIR / RUN_SCRIPT, dest_run)
    dest_run.chmod(0o755)

    dest_prompts = BUILD_DIR / "prompts"
    print(f"Copying prompts/ -> {dest_prompts}")
    shutil.copytree(PROMPTS_DIR, dest_prompts, dirs_exist_ok=True)

    system_prompt = dest_prompts / "health_anxiety_system_prompt.md"
    if not system_prompt.exists():
        raise FileNotFoundError(f"System prompt missing from package: {system_prompt}")


def build_zip():
    """Compress build/ contents at the archive root."""
    print(f"Zipping build/ -> {ZIP_PATH.name}")
    with zipfile.ZipFile(ZIP_PATH, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(BUILD_DIR.rglob("*")):
            if path.is_file():
                zf.write(path, path.relative_to(BUILD_DIR))


def report():
    """Print the final size and the key files inside the archive."""
    size_mb = ZIP_PATH.stat().st_size / (1024 * 1024)
    with zipfile.ZipFile(ZIP_PATH) as zf:
        names = zf.namelist()

    top_level = sorted({n.split("/")[0] for n in names})
    key_files = [
        "run.sh",
        "app.py",
        "lambda_handler.py",
        "reports.py",
        "prompts/health_anxiety_system_prompt.md",
        # prompts/ is copied wholesale, so this one needs no packaging change —
        # it is listed to VERIFY that rather than assume it.
        "prompts/report_analysis_prompt.md",
    ]

    print("\n" + "=" * 60)
    print(f"Built {ZIP_PATH.name}  ({size_mb:.2f} MB, {len(names)} entries)")
    print("=" * 60)

    print("\nKey files:")
    name_set = set(names)
    for f in key_files:
        mark = "OK" if f in name_set else "MISSING"
        print(f"  [{mark}] {f}")

    print("\nTop-level entries in archive:")
    for entry in top_level:
        print(f"  - {entry}")


def main():
    clean()
    install_dependencies()
    copy_sources()
    build_zip()
    shutil.rmtree(BUILD_DIR)  # remove the staging folder, keep only the zip
    print(f"\nRemoved staging dir: {BUILD_DIR}")
    report()


if __name__ == "__main__":
    main()
