Unicode true
!include "MUI2.nsh"

Name "STREAMHUB"
OutFile "release\STREAMHUB-Setup-1.6.4.exe"
InstallDir "$LOCALAPPDATA\Programs\Videowall"
InstallDirRegKey HKCU "Software\STREAMHUB" "InstallLocation"
RequestExecutionLevel admin
SetCompressor /SOLID zlib
Icon "stage160\resources\streamhub.ico"
UninstallIcon "stage160\resources\streamhub.ico"
BrandingText "STREAMHUB 1.6.4"
ShowInstDetails show
ShowUninstDetails show

!define MUI_ABORTWARNING
!define MUI_ICON "stage160\resources\streamhub.ico"
!define MUI_UNICON "stage160\resources\streamhub.ico"
!define MUI_FINISHPAGE_RUN "$INSTDIR\Videowall.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Запустить STREAMHUB"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Russian"

Section "STREAMHUB" SecMain
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  ; Stop and disable the legacy service without touching its data.
  nsExec::ExecToLog 'sc stop VideowallServer'
  nsExec::ExecToLog 'sc config VideowallServer start= disabled'
  nsExec::ExecToLog 'taskkill /F /IM Videowall.exe'
  Sleep 1000
  File /r "stage160\*"
  File /oname=Videowall.bin "payload160\Videowall.payload"
  Delete "$INSTDIR\Videowall.exe"
  Rename "$INSTDIR\Videowall.bin" "$INSTDIR\Videowall.exe"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\STREAMHUB" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\STREAMHUB" "DisplayName" "STREAMHUB"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\STREAMHUB" "DisplayVersion" "1.6.4"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\STREAMHUB" "Publisher" "STREAMHUB"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\STREAMHUB" "DisplayIcon" "$INSTDIR\resources\streamhub.ico"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\STREAMHUB" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  CreateShortcut "$DESKTOP\STREAMHUB.lnk" "$INSTDIR\Videowall.exe" "" "$INSTDIR\resources\streamhub.ico" 0
  CreateDirectory "$SMPROGRAMS\STREAMHUB"
  CreateShortcut "$SMPROGRAMS\STREAMHUB\STREAMHUB.lnk" "$INSTDIR\Videowall.exe" "" "$INSTDIR\resources\streamhub.ico" 0
  CreateShortcut "$SMPROGRAMS\STREAMHUB\Удалить STREAMHUB.lnk" "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  nsExec::ExecToLog 'taskkill /F /IM Videowall.exe'
  Delete "$DESKTOP\STREAMHUB.lnk"
  RMDir /r "$SMPROGRAMS\STREAMHUB"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\STREAMHUB"
  DeleteRegKey HKCU "Software\STREAMHUB"
SectionEnd
