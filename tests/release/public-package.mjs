import { execFileSync } from "node:child_process";

/** Audit the installed bytes, including bundles and copied resources, without dumping matched values. */
export function assertPublicReleasePackage(packagePath) {
  execFileSync("python3", ["-c", String.raw`
import pathlib,re,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    files={entry.filename.removeprefix('qz-browser-agent-extension/'):archive.read(entry)
              for entry in archive.infolist() if not entry.is_dir()}
private_content=[
    re.compile(r'Dog' + r'fooding|idea' + r'Lab|云' + r'壳|集团' + r'(?:登录|工号)', re.I),
    re.compile(r'Agent' + r'Track|Eagle' + r'Eye|\bRpc' + r'ID\b'),
    re.compile(r'(?:alibaba' + r'-inc\.com|antfin\.com|(?:tbsite|aliway)\.(?:net|com)|alidocs\.dingtalk\.com|\w+\.vipserver\b)', re.I),
    re.compile(r'(?<![A-Za-z0-9.])/(?:Users|home)/(?!(?:developer|example|user)(?:/|\b))[\w.-]+/'),
    re.compile(r'-----BEGIN ' + r'(?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    re.compile(r'\b(?:th' + r'-server-|AKIA|LTAI|ghp_|github_pat_)[A-Za-z0-9_-]{16,}'),
    re.compile(r'''(?i)\b(?:serverKey|apiKey|api_key|access_key|secret|password)['"]?\s*[:=]\s*['"][A-Za-z0-9_+/-]{24,}['"]'''),
]
removed_paths=re.compile(r'(?:products/internal/|services/telemetry/|shared/telemetry(?:-release-config)?[.]|background/services/(?:telemetry-runtime|site-bridge)[.])')
removed_runtime=('TELEMETRY_RELEASE_CONFIG','REPORT_RESPONSE_FEEDBACK','/api/telemetry','/api/updates')
violations=set()
for name,data in files.items():
    path=pathlib.PurePosixPath(name)
    if not name or '\\' in name or ':' in name or path.is_absolute() or any(
        part in {'', '.', '..', '.git'} or part.rstrip(' .') != part
        or re.fullmatch(r'(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?', part, re.I)
        for part in name.split('/')
    ): violations.add(name)
    if (removed_paths.search(name) or path.name.startswith('.env')
        or path.suffix.lower() in {'.pem','.key','.p12','.pfx'}
        or path.name.lower() in {'dpsk','credentials','credentials.json'}):
        violations.add(name)
    try:
        text=data.decode('utf-8')
    except UnicodeError:
        continue
    if any(pattern.search(text) for pattern in private_content): violations.add(name)
    if path.suffix in {'.js','.json','.html','.css'}:
        if removed_paths.search(text) or any(marker in text for marker in removed_runtime):
            violations.add(name)
assert not violations, 'Private release content: '+str(sorted(violations))
`, packagePath], { stdio: "pipe" });
}
