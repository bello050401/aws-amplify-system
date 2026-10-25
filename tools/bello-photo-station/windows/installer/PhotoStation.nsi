Unicode true
RequestExecutionLevel user
ManifestDPIAware true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
!include "FileFunc.nsh"
Name "BELLO Photo Station"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\BELLO\PhotoStation"
InstallDirRegKey HKCU "Software\BELLO\PhotoStationInstaller" "InstallDir"
SetCompressor /SOLID lzma
SetCompressorDictSize 32
ShowInstDetails show
ShowUninstDetails show
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey /LANG=1041 "ProductName" "BELLO Photo Station"
VIAddVersionKey /LANG=1041 "FileDescription" "BELLO Photo Station セットアップ"
VIAddVersionKey /LANG=1041 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1041 "LegalCopyright" "BELLO"
Icon "${PAYLOAD_DIR}\BelloPhotoStation.ico"
UninstallIcon "${PAYLOAD_DIR}\BelloPhotoStation.ico"
!define MUI_ABORTWARNING
!define MUI_ICON "${PAYLOAD_DIR}\BelloPhotoStation.ico"
!define MUI_UNICON "${PAYLOAD_DIR}\BelloPhotoStation.ico"
!define MUI_WELCOMEPAGE_TITLE "BELLO Photo Station のセットアップ"
!define MUI_WELCOMEPAGE_TEXT "このWindowsユーザー用にPhoto Stationをインストールします。$\r$\n$\r$\n保存先はBELLO WEB・このPC・社内共有フォルダーから選べます。社外からのWEB保存にも対応しています。$\r$\n$\r$\n必要な.NET・Node.jsは同梱されています。従来のプリセット現像には、Lightroom Classicを別途ご用意ください。"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\お読みください.txt"
!define MUI_FINISHPAGE_SHOWREADME_TEXT "使い方と現在の対応範囲を読む"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH
!insertmacro MUI_LANGUAGE "Japanese"
!define REGKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\BELLOPhotoStation"

!macro CheckRunning
    System::Call 'kernel32::OpenMutexW(i 0x00100000, i 0, w "Local\BELLO.PhotoStation.staging") p.r0'
    ${If} $0 != 0
        System::Call 'kernel32::CloseHandle(p r0)'
        MessageBox MB_ICONEXCLAMATION "Photo Stationを終了してから、もう一度実行してください。" /SD IDOK
        SetErrorLevel 2
        Abort
    ${EndIf}
!macroend

Function .onInit
    SetShellVarContext current
    ${IfNot} ${RunningX64}
        MessageBox MB_ICONSTOP "64ビット版Windowsが必要です。" /SD IDOK
        SetErrorLevel 2
        Abort
    ${EndIf}
    ${IfNot} ${AtLeastWin10}
        MessageBox MB_ICONSTOP "Windows 10以降が必要です。" /SD IDOK
        SetErrorLevel 2
        Abort
    ${EndIf}
    SetRegView 64
    !insertmacro CheckRunning
FunctionEnd

Function ValidateInstallDir
    StrCpy $2 "$INSTDIR"
    checkparent:
        System::Call 'kernel32::GetFileAttributesW(w r2) i.r3'
        ${If} $3 != -1
            IntOp $3 $3 & 0x400
            ${If} $3 != 0
                SetErrors
                Return
            ${EndIf}
        ${EndIf}
        ${GetParent} "$2" $2
        StrCmp $2 "" checkroot
        Goto checkparent
    checkroot:
    ${GetRoot} "$INSTDIR" $0
    ${If} $INSTDIR == $0
    ${OrIf} $INSTDIR == "$0\"
        SetErrors
        Return
    ${EndIf}
    IfFileExists "$INSTDIR\.bello-photo-install" owned
    FindFirst $0 $1 "$INSTDIR\*.*"
    loop:
        StrCmp $1 "" empty
        StrCmp $1 "." next
        StrCmp $1 ".." next
        FindClose $0
        SetErrors
        Return
    next:
        FindNext $0 $1
        Goto loop
    empty:
        FindClose $0
        ClearErrors
        Return
    owned:
        FileOpen $0 "$INSTDIR\.bello-photo-install" r
        FileRead $0 $1
        FileClose $0
        StrCmp $1 "BELLO-PHOTO-STATION-INSTALL-v1" valid
        SetErrors
        Return
    valid:
        ClearErrors
FunctionEnd

Function .onVerifyInstDir
    Call ValidateInstallDir
    IfErrors 0 +2
    Abort
FunctionEnd

Section "Photo Station（必須）" MainSection
    SectionIn RO
    Call ValidateInstallDir
    ${If} ${Errors}
        MessageBox MB_ICONSTOP "空のフォルダー、またはこのインストーラーで導入したPhoto Stationのフォルダーを選んでください。" /SD IDOK
        SetErrorLevel 2
        Abort
    ${EndIf}
    ReadRegStr $0 HKCU "Software\BELLO\PhotoStationInstaller" "InstallDir"
    ${If} $0 != ""
    ${AndIf} $0 != $INSTDIR
        MessageBox MB_ICONSTOP "既存のインストール先を選ぶか、先に既存版をアンインストールしてください。" /SD IDOK
        SetErrorLevel 2
        Abort
    ${EndIf}
    SetOutPath "$INSTDIR"
    ClearErrors
    File /r "${PAYLOAD_DIR}\*.*"
    ${If} ${Errors}
        MessageBox MB_ICONSTOP "ファイルを配置できませんでした。空き容量と書込権限を確認してください。" /SD IDOK
        SetErrorLevel 1
        Abort
    ${EndIf}
    WriteUninstaller "$INSTDIR\Uninstall.exe"
    CreateDirectory "$SMPROGRAMS\BELLO Photo Station"
    CreateShortcut "$SMPROGRAMS\BELLO Photo Station\BELLO Photo Station.lnk" "$INSTDIR\PhotoStation.Desktop.exe" "" "$INSTDIR\BelloPhotoStation.ico"
    CreateShortcut "$SMPROGRAMS\BELLO Photo Station\使い方.lnk" "$INSTDIR\お読みください.txt"
    WriteRegStr HKCU "Software\BELLO\PhotoStationInstaller" "InstallDir" "$INSTDIR"
    WriteRegStr HKCU "${REGKEY}" "DisplayName" "BELLO Photo Station"
    WriteRegStr HKCU "${REGKEY}" "DisplayVersion" "${APP_VERSION}"
    WriteRegStr HKCU "${REGKEY}" "Publisher" "BELLO"
    WriteRegStr HKCU "${REGKEY}" "InstallLocation" "$INSTDIR"
    WriteRegStr HKCU "${REGKEY}" "DisplayIcon" "$INSTDIR\BelloPhotoStation.ico"
    WriteRegStr HKCU "${REGKEY}" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
    WriteRegStr HKCU "${REGKEY}" "QuietUninstallString" '$\"$INSTDIR\Uninstall.exe$\" /S'
    WriteRegDWORD HKCU "${REGKEY}" "NoModify" 1
    WriteRegDWORD HKCU "${REGKEY}" "NoRepair" 1
SectionEnd

Section "デスクトップにショートカットを作成" DesktopSection
    IfFileExists "$DESKTOP\BELLO Photo Station.lnk" desktopDone
    CreateShortcut "$DESKTOP\BELLO Photo Station.lnk" "$INSTDIR\PhotoStation.Desktop.exe" "" "$INSTDIR\BelloPhotoStation.ico"
    WriteRegDWORD HKCU "Software\BELLO\PhotoStationInstaller" "DesktopShortcutCreated" 1
    desktopDone:
SectionEnd

Function un.onInit
    SetShellVarContext current
    SetRegView 64
    !insertmacro CheckRunning
    FileOpen $0 "$INSTDIR\.bello-photo-install" r
    IfErrors notowned
    FileRead $0 $1
    FileClose $0
    StrCmp $1 "BELLO-PHOTO-STATION-INSTALL-v1" owned
    notowned:
        MessageBox MB_ICONSTOP "インストール先を確認できません。ファイルは削除していません。" /SD IDOK
        SetErrorLevel 2
        Abort
    owned:
FunctionEnd

Section "Uninstall"
    !include "${UNINSTALL_INCLUDE}"
    ReadRegStr $0 HKCU "Software\BELLO\PhotoStationInstaller" "InstallDir"
    ${If} $0 == $INSTDIR
        ReadRegDWORD $1 HKCU "Software\BELLO\PhotoStationInstaller" "DesktopShortcutCreated"
        ${If} $1 == 1
            Delete "$DESKTOP\BELLO Photo Station.lnk"
        ${EndIf}
        Delete "$SMPROGRAMS\BELLO Photo Station\BELLO Photo Station.lnk"
        Delete "$SMPROGRAMS\BELLO Photo Station\使い方.lnk"
        RMDir "$SMPROGRAMS\BELLO Photo Station"
        DeleteRegKey HKCU "${REGKEY}"
        DeleteRegKey HKCU "Software\BELLO\PhotoStationInstaller"
    ${EndIf}
SectionEnd
