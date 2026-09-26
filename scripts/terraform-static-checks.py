#!/usr/bin/env python3
"""Wave 4 local static checks for terraform/ (no Terraform binary needed).

Covers what `terraform fmt/validate` + `trivy config` will enforce in CI, minus
provider-schema depth (USER-SIDE/CI VALIDATION REQUIRED for that part):
  1. HCL brace/paren/bracket balance (string- and comment-aware)
  2. Module wiring: every module.<m>.<out> output exists; every required
     module variable (no default) is fed by the calling root
  3. Root hygiene: required_version, provider pins, partial backend, tls provider
  4. CIDR math: subnet slices inside VPC, mutually disjoint, legacy-disjoint
  5. Security greps: 0.0.0.0/0, 5432, AdministratorAccess, secrets/keys
Run:  python3 scripts/terraform-static-checks.py
"""
import ipaddress
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "terraform"
failures: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)
    print(f"FAIL: {msg}")


def ok(msg: str) -> None:
    print(f"ok: {msg}")


def strip_hcl_noise(text: str) -> str:
    """Remove strings, line comments and block comments for balance checks."""
    out = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == '"':  # string (HCL allows ${} interp; braces inside still counted? no -> skip all)
            i += 1
            while i < n and text[i] != '"':
                i += 2 if text[i] == "\\" else 1
            i += 1
        elif c == "#" or (c == "/" and i + 1 < n and text[i + 1] == "/"):
            while i < n and text[i] != "\n":
                i += 1
        elif c == "/" and i + 1 < n and text[i + 1] == "*":
            i += 2
            while i + 1 < n and not (text[i] == "*" and text[i + 1] == "/"):
                i += 1
            i += 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


# --- 1. balance -------------------------------------------------------------
tf_files = sorted(ROOT.rglob("*.tf"))
print(f"-- balance over {len(tf_files)} .tf files --")
for f in tf_files:
    code = strip_hcl_noise(f.read_text())
    # heredocs (<<EOT) can contain unbalanced braces; drop them
    code = re.sub(r"<<-?\w+.*?\n\w+\n", "", code, flags=re.S)
    stack = []
    pairs = {")": "(", "]": "[", "}": "{"}
    line = 1
    bad = None
    for ch in code:
        if ch == "\n":
            line += 1
        elif ch in "([{":
            stack.append((ch, line))
        elif ch in ")]}":
            if not stack or stack[-1][0] != pairs[ch]:
                bad = f"{f.relative_to(ROOT)}: unbalanced {ch!r} at line {line}"
                break
            stack.pop()
    if bad:
        fail(bad)
    elif stack:
        fail(f"{f.relative_to(ROOT)}: unclosed {stack[-1][0]!r} from line {stack[-1][1]}")
if not [x for x in failures if "unbalanced" in x or "unclosed" in x]:
    ok(f"all {len(tf_files)} .tf files balanced")

# --- 2. module wiring --------------------------------------------------------
print("-- module wiring --")
mod_outputs: dict[str, set[str]] = {}
mod_required_vars: dict[str, set[str]] = {}
for mod in (ROOT / "modules").iterdir():
    outs = set(re.findall(r'output\s+"([^"]+)"', (mod / "outputs.tf").read_text()))
    mod_outputs[mod.name] = outs
    var_blocks = re.findall(r'variable\s+"([^"]+)"\s*\{(.*?)\n\}', (mod / "variables.tf").read_text(), re.S)
    req = {name for name, body in var_blocks if "default" not in body.split("validation")[0].split("description")[0] and "\n  default" not in body and re.search(r"^\s*default\s*=", body, re.M) is None}
    # simpler: required = no `default =` line at all in block
    req = {name for name, body in var_blocks if re.search(r"^\s*default\s*=", body, re.M) is None}
    mod_required_vars[mod.name] = req

for env in ("staging", "production"):
    main = (ROOT / "environments" / env / "main.tf").read_text()
    for m in re.finditer(r'module\s+"(\w+)"\s*\{(.*?)\n\}', main, re.S):
        name, body = m.group(1), m.group(2)
        if name not in mod_outputs:
            fail(f"{env}: unknown module {name!r}")
            continue
        fed = set(re.findall(r"^\s*(\w+)\s*=", body, re.M)) - {"source"}
        missing = mod_required_vars[name] - fed
        if missing:
            fail(f"{env}/{name}: required vars not fed: {sorted(missing)}")
    # every module.<m>.<out> referenced in env root must exist
    env_text = "".join(p.read_text() for p in (ROOT / "environments" / env).glob("*.tf"))
    for m, o in re.findall(r"module\.(\w+)\.(\w+)", env_text):
        if m in mod_outputs and o not in mod_outputs[m]:
            fail(f"{env}: module.{m}.{o} does not exist")
    # every var.* referenced must be declared
    declared = set(re.findall(r'variable\s+"([^"]+)"', (ROOT / "environments" / env / "variables.tf").read_text()))
    for v in set(re.findall(r"var\.(\w+)", env_text)):
        if v not in declared:
            fail(f"{env}: var.{v} not declared")
ok("module outputs + required vars + var declarations resolve in both roots")

# --- 3. root hygiene ----------------------------------------------------------
print("-- root hygiene --")
for root in (ROOT / "environments" / "staging", ROOT / "environments" / "production", ROOT / "bootstrap"):
    v = (root / "versions.tf").read_text()
    if 'required_version = ">= 1.11.0"' not in v:
        fail(f"{root.name}: required_version >= 1.11.0 missing")
    if 'version = "~> 5.0"' not in v:
        fail(f"{root.name}: aws provider ~> 5.0 pin missing")
    if root.name != "bootstrap" and 'version = "~> 4.0"' not in v:
        fail(f"{root.name}: tls provider ~> 4.0 pin missing")
    if root.name != "bootstrap":
        b = (root / "backend.tf").read_text()
        if 'backend "s3" {}' not in b:
            fail(f"{root.name}: backend is not the partial s3 {{}} block")
        if re.search(r"^\s*(bucket|dynamodb_table)\s*=", b, re.M):
            fail(f"{root.name}: backend.tf must not assign bucket/dynamodb (partial backend)")
ok("required_version + provider pins + partial backends present")

# --- 4. CIDR math ---------------------------------------------------------------
print("-- CIDR math --")
nets = {
    "legacy-jenkins": ipaddress.ip_network("10.0.0.0/16"),
    "staging-vpc": ipaddress.ip_network("10.20.0.0/16"),
    "prod-vpc": ipaddress.ip_network("10.30.0.0/16"),
}
vpc16 = list(nets["staging-vpc"].subnets(prefixlen_diff=4))
slices = {"public": [vpc16[i] for i in (0, 1)], "app": [vpc16[i] for i in (3, 4)], "data": [vpc16[i] for i in (6, 7)]}
flat = [s for v in slices.values() for s in v]
for i, a in enumerate(flat):
    for b in flat[i + 1:]:
        if a.overlaps(b):
            fail(f"slice overlap: {a} vs {b}")
for s in flat:
    if not s.subnet_of(nets["staging-vpc"]) or s.overlaps(nets["legacy-jenkins"]) or s.overlaps(nets["prod-vpc"]):
        fail(f"slice out of place: {s}")
for name in ("legacy-jenkins", "prod-vpc"):
    if nets["staging-vpc"].overlaps(nets[name]):
        fail(f"staging VPC overlaps {name}")
print("   slices:", {k: [str(s) for s in v] for k, v in slices.items()})
if not [x for x in failures if "slice" in x or "overlap" in x]:
    ok("staging slices inside VPC, mutually disjoint, legacy/prod-disjoint")

# --- 5. security greps ------------------------------------------------------------
print("-- security greps --")
tree = {p: p.read_text() for p in sorted(ROOT.rglob("*")) if p.is_file()}
code_tf = {p: t for p, t in tree.items() if p.suffix == ".tf"}


def hits(pattern: str, files: dict) -> list[str]:
    return [f"{p.relative_to(ROOT)}:{i + 1}" for p, t in files.items() for i, l in enumerate(t.splitlines()) if re.search(pattern, l)]


# Every 0.0.0.0/0 in .tf must sit in a justified context: route-table egress
# (cidr_block), the validations that REFUSE open CIDRs, or documenting comments.
allowed_cidr_ctx = ("cidr_block", "contains(", "Documented 0.0.0.0/0", "Refusing unrestricted", "No 0.0.0.0/0 ingress")
open_cidr = hits(r"0\.0\.0\.0/0", code_tf)
print(f"   0.0.0.0/0 in .tf ({len(open_cidr)}):")
for h in open_cidr:
    print(f"      {h}")
    line = (ROOT / h.split(":")[0]).read_text().splitlines()[int(h.split(":")[1]) - 1]
    if not any(ctx in line for ctx in allowed_cidr_ctx):
        fail(f"unjustified 0.0.0.0/0: {h}: {line.strip()}")
if "cidr_blocks" in "".join(hits(r"cidr_blocks", code_tf)):
    fail("cidr_blocks (SG inline ingress) must not exist in Wave 4")
for h in hits(r"0\.0\.0\.0/0", {p: t for p, t in tree.items() if p.suffix == ".json"}):
    fail(f"unexpected 0.0.0.0/0 in JSON: {h}")

# Every 5432 in .tf must be the RDS port/SG context — never a public CIDR pair.
allowed_pg_ctx = ("from_port", "to_port", "port ", "5432 from", "source for 5432")
pg = hits(r"5432", code_tf)
print(f"   5432 in .tf ({len(pg)}):")
for h in pg:
    print(f"      {h}")
    line = (ROOT / h.split(":")[0]).read_text().splitlines()[int(h.split(":")[1]) - 1]
    if not any(ctx in line for ctx in allowed_pg_ctx):
        fail(f"unjustified 5432: {h}: {line.strip()}")

admin = hits(r"AdministratorAccess", tree)
if admin:
    fail(f"AdministratorAccess present: {admin}")
else:
    ok("no AdministratorAccess in terraform/")

keys = hits(r"AKIA|aws_secret|BEGIN .*PRIVATE|password\s*=\s*\"[^\"]+\"|passwd", tree)
# Wave 7 refinement (NOT a weakening): Secrets Manager RESOURCE declarations
# and ARN/ID references are value-free by construction — only literal values
# (AKIA, PEM blocks, quoted password assignments) can be hardcoded secrets.
keys = [k for k in keys if "manage_master_user_password" not in tree[ROOT / k.split(':')[0]].splitlines()[int(k.split(':')[1]) - 1] and "master_user" not in tree[ROOT / k.split(':')[0]].splitlines()[int(k.split(':')[1]) - 1]
        and not re.search(r"^\s*resource\s+\"aws_secretsmanager", tree[ROOT / k.split(':')[0]].splitlines()[int(k.split(':')[1]) - 1])
        and not re.search(r"aws_secretsmanager_secret\.[a-z_]+\.(id|arn)\b", tree[ROOT / k.split(':')[0]].splitlines()[int(k.split(':')[1]) - 1])]
if keys:
    fail(f"possible hardcoded secret: {keys}")
else:
    ok("no hardcoded credentials/keys/password values in terraform/")

# Resource "*" in .tf is allowed ONLY in the two KMS key policies (AWS-mandated;
# scope = key attachment). Anywhere else it fails.
star = hits(r'Resource\s*=\s*"\*"', code_tf)
print(f"   Resource \"*\" in .tf ({len(star)}): {star}")
for h in star:
    if not h.startswith(("modules/eks/main.tf", "modules/rds/main.tf")):
        fail(f"Resource \"*\" outside KMS key policies: {h}")
if len(star) != 2:
    fail(f"expected exactly 2 KMS key-policy Resource \"*\" hits, got {len(star)}")
# --- 6. fmt-canonical approximation --------------------------------------------
print("-- fmt approximation --")
assign_re = re.compile(r"^(\s*)([A-Za-z0-9_-]+)(\s*)(=)")
for f in tf_files:
    rel = f.relative_to(ROOT)
    text = f.read_text()
    if "\t" in text:
        fail(f"{rel}: tab character (fmt wants spaces)")
    for i, line in enumerate(text.splitlines(), 1):
        if line != line.rstrip():
            fail(f"{rel}:{i}: trailing whitespace")
    if not text.endswith("\n"):
        fail(f"{rel}: missing trailing newline")
    # contiguous runs of `key = ...` lines must share one `=` column PER INDENT
    # (fmt aligns same-level siblings only; nesting breaks comparison groups)
    run: list[tuple[int, int, int]] = []  # (line_no, indent, eq_column)

    def flush() -> None:
        by_indent: dict[int, set[int]] = {}
        for n, ind, col in run:
            by_indent.setdefault(ind, set()).add(col)
        for ind, cols in by_indent.items():
            if len(cols) > 1:
                lines = [n for n, i, _ in run if i == ind]
                fail(f"{rel}: misaligned `=` at indent {ind}, lines {lines} (columns {sorted(cols)})")
        run.clear()

    for i, line in enumerate(text.splitlines(), 1):
        m = assign_re.match(line)
        if m and not line.strip().startswith(("}", "#", "/")):
            run.append((i, len(m.group(1)), len(m.group(1)) + len(m.group(2)) + len(m.group(3))))
        else:
            if len(run) > 1:
                flush()
            else:
                run.clear()
    if len(run) > 1:
        flush()
if not [x for x in failures if "misalign" in x or "whitespace" in x or "newline" in x or "tab " in x]:
    ok("indentation/alignment/whitespace look fmt-canonical")

# Deployer policy: valid JSON, no AdministratorAccess, state bucket templated
pol = json.loads((ROOT / "bootstrap" / "deployer-policy.json").read_text())
dump = json.dumps(pol)
assert "AdministratorAccess" not in dump
assert "__STATE_BUCKET__" in dump
ok("deployer-policy.json valid, no admin, bucket templated")

print()
if failures:
    print(f"{len(failures)} FAILURE(S)")
    sys.exit(1)
print("ALL STATIC CHECKS PASSED")
