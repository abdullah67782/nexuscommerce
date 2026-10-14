"""Build the Kaggle training/calibration package (dataset ZIP) and its notebook.

    python build_package.py <output folder>

Creates
  nexus_stage3_package.zip            -> upload as ONE private Kaggle dataset
  stage3_training_calibration.ipynb   -> import into Kaggle as a notebook
The package carries only development code, frozen protocol files, the app's v2 code and models, the M5 files
(read only through the guarded loader) and the Pakistan DEVELOPMENT extract. It contains no final-evaluation step.
"""
import hashlib
import json
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
STAGE3 = HERE.parent
REPO = STAGE3.parents[1]
S3 = "kaggle_training/stage3"

FILES = [
    "ml/v2/__init__.py", "ml/v2/features.py", "ml/v2/forecast.py", "ml/v2/methods.py", "ml/v2/registry.py",
    "ml/models_v2/manifest.json", "ml/models_v2/shared_total_7.json", "ml/models_v2/shared_total_28.json",
    "data/m5/calendar.csv", "data/m5/sales_train_evaluation.csv.zip", "data/m5/sell_prices.csv.zip",
    f"{S3}/data_access.py", f"{S3}/served.py", f"{S3}/events.py", f"{S3}/e1_layer.py", f"{S3}/u2_artifacts.py",
    f"{S3}/final/common.py", f"{S3}/final/calibrate.py", f"{S3}/final/final_access.py", f"{S3}/final/final_runner.py",
    f"{S3}/final/exact_recheck.py", f"{S3}/final/freeze_final_protocol.py",
    f"{S3}/kaggle/pkg_steps.py", f"{S3}/kaggle/pins.json",
    f"{S3}/data_dev/pakistan_dev_2016-07-01_2017-12-31.csv", f"{S3}/data_dev/pakistan_dev_manifest.json",
    f"{S3}/outputs/reservation_m5.json", f"{S3}/outputs/dev_protocol.json", f"{S3}/outputs/dev_protocol.sha256",
    f"{S3}/outputs/dev_protocol_amendment_A1.json", f"{S3}/outputs/dev_protocol_amendment_A2.json",
    f"{S3}/outputs/final_protocol.json", f"{S3}/outputs/final_protocol.sha256",
    f"{S3}/outputs/us/uncertainty_selection.json", f"{S3}/outputs/us/decision_selection.json",
    f"{S3}/outputs/final_prep/exact_recheck.json",
] + [f"{S3}/outputs/final_prep/dev_reference/{p.name}" for p in sorted((STAGE3 / "outputs/final_prep/dev_reference").iterdir())] \
  + [f"{S3}/outputs/u2_selected/{p.name}" for p in sorted((STAGE3 / "outputs/u2_selected").iterdir())] \
  + [f"{S3}/outputs/research_models/{p.name}" for p in sorted((STAGE3 / "outputs/research_models").iterdir())]


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


README = """# Nexus Stage 3 - training / calibration package (development data only)

Upload this ZIP as ONE private Kaggle dataset, then run `stage3_training_calibration.ipynb`.

- Protocol: nexus-stage3-final-protocol-v1, sha256 {sha}
- No final evaluation is included; reserved outcomes are not read (guarded loaders).
- Production models, routing and replenishment-1 are not changed; nothing here is integrated anywhere.
- Libraries are installed in an isolated environment with the app's exact versions (numpy 1.26.4, pandas 2.2.2,
  scipy 1.17.1, xgboost 3.4.1, scikit-learn 1.5.1, Python 3.12).
"""


def md(text):
    return {"cell_type": "markdown", "metadata": {}, "source": text.strip("\n").splitlines(keepends=True)}


def code(text):
    return {"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": text.strip("\n").splitlines(keepends=True)}


def notebook(protocol_sha):
    cells = [
        md(f"""
# Nexus Stage 3 - training and calibration (development data only)

**What this notebook does:** checks the frozen protocol, reproduces the development results, retrains the U2 quantile
boosters on CPU to check reproducibility (and on GPU as a diagnostic only), computes the final calibration, and packs
everything into one ZIP for you to send back.

**What it does not do:** it does not run the final evaluation, does not read reserved outcomes, and does not change or
replace any production model.

Protocol `nexus-stage3-final-protocol-v1`, sha256 `{protocol_sha}`

### Before you run
1. **Add data** (right panel): your private dataset made from `nexus_stage3_package.zip`.
2. **Settings, then Accelerator:** `GPU T4` (any GPU works; with *None* the GPU check is skipped and everything else still runs).
3. **Settings, then Internet:** **On** (needed once, to install the app's exact library versions).
4. Run the cells **1 to 9 in order** (or *Run All*). Each cell stops with a clear message if something is wrong. If a cell fails, do not
   change anything: download `/kaggle/working/stage3_run/logs` and send it back.
5. At the end, download **`nexus_stage3_training_calibration_output.zip`** (cell 9, or the *Output* tab) and send it back.
"""),
        md("## Cell 1 - find the package and set the paths"),
        code("""
import glob, json, os, shutil, subprocess, sys
from pathlib import Path

markers = glob.glob('/kaggle/input/**/NEXUS_STAGE3_PACKAGE.json', recursive=True)
assert len(markers) == 1, f'expected exactly one Nexus Stage 3 package in /kaggle/input, found {len(markers)}: add the dataset (Before you run, step 1)'
PKG = Path(markers[0]).parent
REPO = Path('/kaggle/working/nexus_repo')
WORK = Path('/kaggle/working/stage3_run')
if not REPO.exists():
    shutil.copytree(PKG / 'repo', REPO)
STEPS = REPO / 'kaggle_training/stage3/kaggle/pkg_steps.py'
info = json.loads(Path(markers[0]).read_text())
print('package :', info['package'])
print('protocol:', info['protocol_sha256'])
print('files   :', info['file_count'])
"""),
        md("## Cell 2 - install the app's exact library versions (isolated Python 3.12 environment)"),
        code("""
VENV = Path('/kaggle/working/venv')
PY = str(VENV / 'bin' / 'python')
pins = json.loads((REPO / 'kaggle_training/stage3/kaggle/pins.json').read_text())['pip']
if not Path(PY).exists():
    subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', 'uv'], check=True)
    made = subprocess.run(['uv', 'venv', '--python', '3.12', str(VENV)])
    if made.returncode != 0:
        assert sys.version_info[:2] <= (3, 12), 'could not create a Python 3.12 environment; send this output back'
        subprocess.run([sys.executable, '-m', 'venv', str(VENV)], check=True)
    subprocess.run(['uv', 'pip', 'install', '--python', PY, '-q', *pins], check=True)
print(subprocess.run([PY, '-c', 'import sys, numpy, pandas, scipy, xgboost; print(sys.version.split()[0], numpy.__version__, pandas.__version__, scipy.__version__, xgboost.__version__)'],
                     capture_output=True, text=True).stdout)

def run(step):
    env = dict(os.environ, NEXUS_WORK=str(WORK), PYTHONHASHSEED='0')
    p = subprocess.Popen([PY, str(STEPS), step], cwd=str(STEPS.parent), env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for line in p.stdout:
        print(line, end='')
    if p.wait() != 0:
        raise RuntimeError(f'step {step} failed: stop here and send /kaggle/working/stage3_run/logs back')
"""),
        md("## Cell 3 - environment and GPU check"),
        code("run('env')"),
        md("## Cell 4 - verify the frozen protocol and every listed file hash"),
        code("run('verify')"),
        md("## Cell 5 - reproduce the development results (research model copies; development data only)"),
        code("run('reproduce')"),
        md("## Cell 6 - retrain U2 on CPU and compare with the selected boosters (the selected boosters are not replaced)"),
        code("run('u2_cpu')"),
        md("## Cell 7 - GPU diagnostic (never selected; skipped automatically without a GPU)"),
        code("run('u2_gpu')"),
        md("## Cell 8 - final calibration (US development products 2015-06..10; Pakistan development extract)"),
        code("run('calibrate')"),
        md("## Cell 9 - package the outputs and download the ZIP"),
        code("""
run('package')
src = WORK / 'nexus_stage3_training_calibration_output.zip'
dst = Path('/kaggle/working/nexus_stage3_training_calibration_output.zip')
shutil.copy(src, dst)
from IPython.display import FileLink, display
display(FileLink(str(dst.relative_to('/kaggle/working'))))
print('Send this file back:', dst)
"""),
    ]
    return {"cells": cells, "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
                                         "language_info": {"name": "python"}}, "nbformat": 4, "nbformat_minor": 5}


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    protocol_sha = (STAGE3 / "outputs" / "final_protocol.sha256").read_text().split()[0]
    frozen = json.loads((STAGE3 / "outputs" / "final_protocol.json").read_text())["hashes"]
    hashes = {}
    zpath = out / "nexus_stage3_package.zip"
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for rel in FILES:
            src = REPO / rel
            if not src.is_file():
                raise SystemExit(f"missing {rel}")
            data = src.read_bytes()
            expected = frozen.get(rel)
            if expected and hashlib.sha256(data).hexdigest() != expected:
                lf = data.replace(b"\r\n", b"\n")      # a Windows checkout may hold CRLF copies of frozen text files
                if hashlib.sha256(lf).hexdigest() != expected:
                    raise SystemExit(f"{rel} differs from the frozen protocol hash")
                data = lf
            z.writestr(f"nexus_stage3_package/repo/{rel}", data)
            hashes[rel] = hashlib.sha256(data).hexdigest()
        marker = {"package": "nexus-stage3-training-calibration-v1", "protocol_sha256": protocol_sha, "file_count": len(FILES),
                  "files": hashes, "final_evaluation_included": False}
        z.writestr("nexus_stage3_package/NEXUS_STAGE3_PACKAGE.json", json.dumps(marker, indent=2))
        z.writestr("nexus_stage3_package/README.md", README.format(sha=protocol_sha))
    nb = out / "stage3_training_calibration.ipynb"
    nb.write_text(json.dumps(notebook(protocol_sha), indent=1))
    print(zpath, f"{zpath.stat().st_size / 1e6:.1f} MB", sha(zpath))
    print(nb, sha(nb))


if __name__ == "__main__":
    main()
