from pathlib import Path
import shutil,json,hashlib,datetime,zipfile
repo=Path(__file__).resolve().parents[2]
source=repo.parent/'photo-station-test-20261018/source'
target=repo/'tools/bello-photo-station'
# Keep the distributable source in Git, excluding runtime output, accounts and photos.
for name in ['src','test','assets','presets','lightroom','windows']:
 for p in (source/name).rglob('*'):
  if not p.is_file() or any(x in ['bin','obj','node_modules','manual'] for x in p.relative_to(source).parts):continue
  if p.suffix not in ['.mjs','.cs','.xaml','.csproj','.slnx','.png','.ico','.jpg','.xmp','.lua','.ps1','.nsi','.md'] and p.name!='.gitignore':continue
  out=target/p.relative_to(source);out.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,out)
for name in ['package.json','package-lock.json','Install-LightroomBridge.ps1','Configure-DedicatedPC.ps1','Test-PhotoStationReadiness.ps1','PRESET-WORKFLOW.md']:
 shutil.copy2(source/name,target/name)
old=Path('E:/Belloシステム開発/05_配布用/PhotoStation/20261024/r11-original-cloud/BELLO-Photo-Station-Windows-x64')
dest=Path('E:/Belloシステム開発/05_配布用/PhotoStation/20261025/r12-import-originals')
package=dest/'BELLO-Photo-Station-Windows-x64'
if not package.exists():shutil.copytree(old,package)
for p in (source.parent/'r12-publish').rglob('*'):
 if p.is_file():out=package/'app'/p.relative_to(source.parent/'r12-publish');out.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,out)
for p in (source/'src').glob('*.mjs'):shutil.copy2(p,package/'app/pipeline/src'/p.name)
(package/'version-r11.json').unlink(missing_ok=True)
allowed={'default-preset.json','presets'}
assert set(p.name for p in (package/'data').iterdir())<=allowed,'No account/history/session data in distribution'
manifest={'version':'r12-import-originals','builtAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'touchEnabled':True,'personalDataIncluded':False,'files':[]}
for p in package.rglob('*'):
 if p.is_file() and p.name!='version-r12.json':manifest['files'].append({'path':p.relative_to(package).as_posix(),'size':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
(package/'version-r12.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
archive=dest/'BELLO-Photo-Station-r12-タッチ対応フル版.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=4) as z:
 for p in package.rglob('*'):
  if p.is_file():z.write(p,Path(package.name)/p.relative_to(package))
print(json.dumps({'package':str(package),'archive':str(archive),'size':archive.stat().st_size,'files':len(manifest['files'])},ensure_ascii=False))
