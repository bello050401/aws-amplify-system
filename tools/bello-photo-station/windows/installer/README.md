# Photo Station 1.0 installer

The Windows x64 app saves through the existing BELLO photo API or to a selected PC/shared folder. The destination is remembered per Windows user. Local saves never require or receive a WEB token. A complete product directory is published only after all copies pass SHA-256 checks; retries verify existing files without overwriting user edits. Local-only sessions retain originals and can subsequently save to WEB.

The existing Cognito public client now supports USER_PASSWORD_AUTH in addition to its previous flows. The Windows app uses public InitiateAuth/RespondToAuthChallenge/refresh operations, never AWS administrative credentials. It accepts only the existing issuer, client audience, ID token and PHOTO_DEVICE group, with the existing API gateway still verifying the JWT. The refresh token remains protected using Windows DPAPI. NEW_PASSWORD_REQUIRED, SMS MFA and authenticator MFA responses are supported. The deployed client configuration was preserved except for adding the public password flow; infra/photo-e2e/template.yaml records that setting.

End users need Windows 10/11 x64. .NET and Node are bundled. The existing preset/RAW rendering workflow requires separately licensed Lightroom Classic on each PC. The app's Lightroom setup button installs its bridge and preset; the user starts the bridge inside Lightroom. Outside the office, WEB save needs internet; internal file shares need the company's existing remote network/VPN connection. This app does not expose SMB shares to the internet.

Build requirements: PowerShell 7, .NET 10 SDK, Windows x64 Node with npm and its matching LICENSE, NSIS 3.12+.

```powershell
./Build-Installer.ps1 -NodeExe 'C:/Program Files/nodejs/node.exe' -NodeLicense 'C:/tools/Node-LICENSE.txt' -NsisExe 'C:/tools/nsis/makensis.exe' -OutputDir 'C:/builds/photo-1.0.0'
./Verify-Package.ps1 -PayloadDir 'C:/builds/photo-1.0.0/payload'
```

OutputDir must be new/empty and outside the source tree. Build scripts never recursively delete caller-selected paths. Dependencies are installed from the lockfile with scripts disabled. The bundled sharp runtime processes a synthetic image, and the payload hash manifest is verified before compilation. No passwords, AWS credentials, photos or history are included.

Install is per-user, with Start Menu entries and an optional Desktop shortcut. Uninstall removes the exact packaged files and empty directories only. Application data, unknown files, Lightroom configuration and existing encrypted sign-in remain. WEB sign-out is available inside the app. The API's destination, operations and payload contract are unchanged. The executable is unsigned.

`PhotoStation.Desktop.exe --installation-check` displays the WPF window with interactions disabled, a temporary data root and no login, card scanning or retention. For normal workflow verification use an isolated BELLO_PHOTO_STATION_ROOT and empty test card root, never real customer data. The operator-only test/manual/external-login-smoke.mjs creates/removes its own temporary validation account and verifies public sign-in without resolving IAM credentials; it is not packaged in the installer. Keep real external-PC/VPN testing distinct from tests run on the build PC.
