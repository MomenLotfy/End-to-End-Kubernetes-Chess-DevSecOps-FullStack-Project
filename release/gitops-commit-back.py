#!/usr/bin/env python3
"""Wave 5 commit-back: write Wave 3 release digests into the GitOps images.yaml.

Line-based (stdlib only, no YAML round-trip): comments and formatting are
preserved byte-for-byte; only the 4 value lines change. Fails closed when the
expected schema lines are missing (drift -> visible CI failure, never a
half-written file).

Usage (from the release workflow):
  python3 release/gitops-commit-back.py \
    --images-yaml /path/to/images.yaml \
    --index release-index.json

release-index.json schema: {"images": [{"name": "chess-backend",
  "image": {"registry": ..., "digest": "sha256:..."}} x3]}.
images.yaml schema: global.registry + backend/frontend/migration image.digest.
"""
import json
import re
import sys
from pathlib import Path

DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
WANT = {"chess-backend": "backend", "chess-frontend": "frontend", "chess-migration": "migration"}


def main() -> None:
    args = sys.argv[1:]
    try:
        yaml_path = Path(args[args.index("--images-yaml") + 1])
        index_path = Path(args[args.index("--index") + 1])
    except (ValueError, IndexError):
        print("usage: gitops-commit-back.py --images-yaml FILE --index FILE", file=sys.stderr)
        sys.exit(2)
    index = json.loads(index_path.read_text())
    digests: dict[str, str] = {}
    registries: set[str] = set()
    for img in index["images"]:
        key = WANT[img["name"]]
        digest = img["image"]["digest"]
        if not DIGEST_RE.match(digest):
            print(f"refusing weak digest for {img['name']}: {digest!r}", file=sys.stderr)
            sys.exit(1)
        digests[key] = digest
        registries.add(img["image"]["registry"])
    if set(digests) != set(WANT.values()) or len(registries) != 1:
        print(f"index must carry all 3 images from one registry: {index}", file=sys.stderr)
        sys.exit(1)
    registry = registries.pop()

    lines = yaml_path.read_text().splitlines(keepends=True)
    section: str | None = None
    done = {"registry": False, "backend": False, "frontend": False, "migration": False}
    for i, line in enumerate(lines):
        top = re.match(r"^(\w[\w-]*):\s*(#.*)?$", line)
        if top:
            section = top.group(1)
        if section == "global" and re.match(r"^\s+registry\s*:", line):
            lines[i] = re.sub(r":\s*\S+(\s*(#.*)?)?$", f": {registry}", line.rstrip("\n")) + "\n"
            done["registry"] = True
        if section in WANT.values() and re.match(r"^\s+digest\s*:", line):
            lines[i] = re.sub(r":\s*\S+(\s*(#.*)?)?$", f": {digests[section]}", line.rstrip("\n")) + "\n"
            done[section] = True
    missing = sorted(k for k, v in done.items() if not v)
    if missing:
        print(f"images.yaml schema drift, untouched (missing: {missing})", file=sys.stderr)
        sys.exit(1)
    yaml_path.write_text("".join(lines))
    print(f"commit-back: registry={registry} " + " ".join(f"{k}={v[:19]}..." for k, v in digests.items()))


if __name__ == "__main__":
    main()
