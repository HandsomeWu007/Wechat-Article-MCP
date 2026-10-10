"""Create both self-contained client packages from the verified bundled programs."""
from pathlib import Path
import hashlib
import json
import os
import subprocess
import tempfile
import zipfile

root = Path(__file__).resolve().parents[1]
version = json.loads((root / 'package.json').read_text(encoding='utf-8'))['version']
output = root / 'release'
output.mkdir(exist_ok=True)
files = [root / name for name in ('README.md', 'SKILL.md', 'LICENSE', 'config.example.json', 'package.json', 'package-lock.json', 'tsconfig.json')]
for directory in ('bin', 'install', 'src', 'scripts', 'tests'):
    files.extend(p for p in (root / directory).rglob('*') if p.is_file() and not any(part.startswith('.') or part == '__pycache__' for part in p.relative_to(root).parts))
files = sorted(set(files))
for program in ('wechat-mp.mjs', 'wechat-mp-cli.mjs'):
    if not (root / 'bin' / program).is_file():
        raise SystemExit('Run npm run release first')
checksums = []
for client in ('codex', 'dsh'):
    archive = output / f'wechat-mp-mcp-{client}-v{version}.zip'
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for file in files:
            relative = file.relative_to(root).as_posix()
            entry = zipfile.ZipInfo('wechat-mp-mcp/' + relative, date_time=(2026, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = (0o100755 if relative.endswith('.sh') else 0o100644) << 16
            z.writestr(entry, file.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
        entry = zipfile.ZipInfo('wechat-mp-mcp/INSTALL.txt', date_time=(2026, 1, 1, 0, 0, 0))
        z.writestr(entry, f'v{version}: {client}\nWindows: powershell -ExecutionPolicy Bypass -File install/install-{client}.ps1\nmacOS/Linux: bash install/install-{client}.sh\nRequires Node >=22.19. No npm install needed.\n')
    with zipfile.ZipFile(archive) as z:
        assert z.testzip() is None
        assert not any('/.tmp-' in n or n.endswith('/config.json') or 'node_modules/' in n for n in z.namelist())
        with tempfile.TemporaryDirectory(prefix='wechat-package-') as temp:
            z.extractall(temp)
            extracted = Path(temp) / 'wechat-mp-mcp'
            fixture = Path(temp) / 'runtime.json'
            fixture.write_text(json.dumps({'safetyDir': str(Path(temp) / 'safety')}), encoding='utf-8')
            node = os.environ.get('WECHAT_MP_NODE', 'node')
            for program in ('wechat-mp.mjs', 'wechat-mp-cli.mjs'):
                subprocess.run([node, '--check', str(extracted / 'bin' / program)], check=True)
            result = subprocess.check_output([node, str(extracted / 'bin' / 'wechat-mp-cli.mjs'), 'status'], env={**os.environ, 'WECHAT_MP_CONFIG': str(fixture)}, text=True, encoding='utf-8')
            assert json.loads(result)['ok'] is True
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    checksums.append(f'{digest}  {archive.name}')
    print(f'PASS ZIP integrity, syntax, extracted CLI status: {archive.name}')
(output / 'SHA256SUMS.txt').write_text('\n'.join(checksums) + '\n', encoding='utf-8')
print('\n'.join(checksums))

