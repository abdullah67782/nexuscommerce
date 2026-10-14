"""Issue a new version of the final package manifest after a reviewed code change (no other file may change).

    python update_package_manifest.py "<reason>"

Keeps the superseded manifest as final_package_manifest_v<N>.json, writes the new final_package_manifest.json with
manifest_version N+1, the superseded sha256, the reason, and fresh hashes of exactly the same file list.
Protocol v1, F1, F2 and the calibration freeze must be unchanged (their hashes are checked).
"""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402

D = C.D
OUT = C.STAGE3 / "outputs"
REPO = C.STAGE3.parents[1]


def main():
    reason = sys.argv[1]
    path = OUT / "final_package_manifest.json"
    old = json.loads(path.read_text())
    old_sha = D.sha256(path)
    version = int(old.get("manifest_version", 1))
    for k, rel in (("protocol_sha256", "final_protocol.json"),):
        if D.sha256(OUT / rel) != old[k]:
            raise SystemExit("protocol v1 changed: not allowed")
    for name, digest in old["amendments"].items():
        if D.sha256(OUT / f"final_amendment_{name}.json") != digest:
            raise SystemExit(f"amendment {name} changed: not allowed")
    changed = [rel for rel, digest in old["files"].items() if D.sha256(REPO / rel) != digest]
    allowed = {"kaggle_training/stage3/final/final_execute.py", "kaggle_training/stage3/final/preflight.py"}
    if not changed or set(changed) - allowed:
        raise SystemExit(f"changed files {changed}: only reviewed entry-point code may change in a manifest update")
    (OUT / f"final_package_manifest_v{version}.json").write_text(path.read_text())
    new = dict(old)
    new.update({"manifest_version": version + 1, "supersedes": {"version": version, "sha256": old_sha},
                "change": {"reason": reason, "files_changed": changed},
                "files": {rel: D.sha256(REPO / rel) for rel in old["files"]},
                "frozen_at": datetime.now(timezone.utc).isoformat(timespec="seconds")})
    path.write_text(json.dumps(new, indent=2) + "\n")
    sha = D.sha256(path)
    (OUT / "final_package_manifest.sha256").write_text(f"{sha}  final_package_manifest.json\n")
    print(json.dumps({"manifest_version": version + 1, "sha256": sha, "supersedes": old_sha, "changed": changed}, indent=1))


if __name__ == "__main__":
    main()
