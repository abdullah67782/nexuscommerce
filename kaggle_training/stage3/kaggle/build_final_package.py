"""Build the ONE-TIME final-evaluation package (protocol v1 + amendments F1, F2).

    python build_final_package.py <output folder>

Creates nexus_stage3_final_package.zip: everything in the training/calibration package, plus the frozen
calibration (laptop run), amendments F1/F2, the package manifest, preflight.py and final_execute.py.
It does NOT contain the Pakistan source file; the run reads it from the owner's own copy (hash-checked).
Every file whose hash is frozen (protocol v1 list or the package manifest) is written with exactly the frozen
bytes (a Windows checkout's CRLF copy is normalised back, otherwise the build stops).
"""
import hashlib
import json
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from build_package import FILES, REPO, S3, STAGE3  # noqa: E402

README = """# Nexus Stage 3 — one-time final evaluation package

Protocol v1 `{proto}` + amendment F1 `{f1}` + amendment F2 `{f2}`
Package manifest sha256 `{man}` · calibration freeze sha256 `{freeze}`

Run with the app's ML environment (Python 3.12, numpy 1.26.4, pandas 2.2.2, scipy 1.17.1, xgboost 3.4.1).
From `nexus_stage3_package/repo/kaggle_training/stage3/final`:

1. Preflight only (development data; no lock; reserved outcomes are not accessed):

   python final_execute.py preflight --manifest-sha {man} --calibration ../outputs/final_prep/verification/laptop_run/calibration --calibration-freeze-sha {freeze} --pakistan-source "<path to Pakistan Largest Ecommerce Dataset.csv>" --out <empty folder>

2. Only after the preflight results have been reviewed and approved, the one-time evaluation:

   python final_execute.py execute-once --confirm {proto} --manifest-sha {man} --calibration ../outputs/final_prep/verification/laptop_run/calibration --calibration-freeze-sha {freeze} --pakistan-source "<path>" --lock-dir <persistent folder> --out <new empty folder>

Decision-protection results are research-only (amendment F1). Production is not changed.
"""


def sha(b):
    return hashlib.sha256(b).hexdigest()


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    o = STAGE3 / "outputs"
    proto = json.loads((o / "final_protocol.json").read_text())
    manifest = json.loads((o / "final_package_manifest.json").read_text())
    man_sha = (o / "final_package_manifest.sha256").read_text().split()[0]
    frozen = dict(proto["hashes"])
    frozen.update(manifest["files"])
    extra = list(manifest["files"]) + [f"{S3}/outputs/final_package_manifest.json", f"{S3}/outputs/final_package_manifest.sha256"] + \
        [f"{S3}/outputs/{p.name}" for p in sorted(o.glob("final_package_manifest_v*.json"))]
    rels = list(dict.fromkeys(FILES + extra))
    hashes = {}
    zpath = out / "nexus_stage3_final_package.zip"
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for rel in rels:
            data = (REPO / rel).read_bytes()
            want = frozen.get(rel) or (man_sha if rel.endswith("final_package_manifest.json") else None)
            if want and sha(data) != want:
                lf = data.replace(b"\r\n", b"\n")
                if sha(lf) != want:
                    raise SystemExit(f"{rel} differs from its frozen hash")
                data = lf
            z.writestr(f"nexus_stage3_package/repo/{rel}", data)
            hashes[rel] = sha(data)
        marker = {"package": manifest["package"], "manifest_version": manifest.get("manifest_version", 1), "protocol_sha256": manifest["protocol_sha256"], "manifest_sha256": man_sha,
                  "amendments": manifest["amendments"], "calibration_freeze_sha256": manifest["calibration_freeze_sha256"],
                  "file_count": len(rels), "files": hashes, "pakistan_source_included": False}
        z.writestr("nexus_stage3_package/NEXUS_STAGE3_FINAL_PACKAGE.json", json.dumps(marker, indent=2))
        z.writestr("nexus_stage3_package/README.md", README.format(proto=manifest["protocol_sha256"], f1=manifest["amendments"]["F1"],
                                                                     f2=manifest["amendments"]["F2"], man=man_sha,
                                                                     freeze=manifest["calibration_freeze_sha256"]))
    content = sha(json.dumps(hashes, sort_keys=True).encode())
    print(zpath, f"{zpath.stat().st_size / 1e6:.1f} MB", "content digest", content)


if __name__ == "__main__":
    main()
