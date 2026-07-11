; Velo NSIS Installer Hooks
;
; ProgID + default-open + folder/md context menu managed by hooks
; installMode=currentUser: SHCTX=HKCU

Var VeloChkDefaultOpen
Var VeloChkMenu
Var VeloChkMdMenu
Var VeloOptDefaultOpen
Var VeloOptFolderMenu
Var VeloOptMdMenu

; -- Additional Tasks --

Function PageTasks
  ${If} $PassiveMode = 1
    StrCpy $VeloOptDefaultOpen 0
    StrCpy $VeloOptFolderMenu 1
    StrCpy $VeloOptMdMenu 1
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "其他任务" "选择要执行的附加任务"
  ${NSD_CreateCheckbox} 0 10u 100% 12u "将 Markdown 文件设为默认使用 Velo 打开"
  Pop $VeloChkDefaultOpen
  ${NSD_CreateCheckbox} 0 30u 100% 12u '添加"在 Velo 中打开"到文件夹右键菜单'
  Pop $VeloChkMenu
  ${NSD_SetState} $VeloChkMenu ${BST_CHECKED}
  ${NSD_CreateCheckbox} 0 50u 100% 12u '添加"在 Velo 中打开"到 Markdown 文件右键菜单'
  Pop $VeloChkMdMenu
  ${NSD_SetState} $VeloChkMdMenu ${BST_CHECKED}
  nsDialogs::Show
FunctionEnd

Function LeaveTasks
  ${NSD_GetState} $VeloChkDefaultOpen $VeloOptDefaultOpen
  ${NSD_GetState} $VeloChkMenu $VeloOptFolderMenu
  ${NSD_GetState} $VeloChkMdMenu $VeloOptMdMenu
FunctionEnd
; -- POSTINSTALL --

!macro NSIS_HOOK_POSTINSTALL

  ${If} $PassiveMode = 1
    StrCpy $VeloOptDefaultOpen 0
    StrCpy $VeloOptFolderMenu 1
    StrCpy $VeloOptMdMenu 1
  ${EndIf}

  WriteRegStr SHCTX "Software\Classes\Velo.md" "" "Markdown 文档"
  WriteRegStr SHCTX "Software\Classes\Velo.md\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr SHCTX "Software\Classes\Velo.md\shell" "" "open"
  WriteRegStr SHCTX "Software\Classes\Velo.md\shell\open" "" "Open with Velo"
  WriteRegStr SHCTX "Software\Classes\Velo.md\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""

  ${If} $VeloOptDefaultOpen == 1
    ReadRegStr $0 SHCTX "Software\Classes\.md" ""
    WriteRegStr SHCTX "Software\Classes\.md" "Velo.md_backup" "$0"
    WriteRegStr SHCTX "Software\Classes\.md" "" "Velo.md"
    ReadRegStr $0 SHCTX "Software\Classes\.markdown" ""
    WriteRegStr SHCTX "Software\Classes\.markdown" "Velo.md_backup" "$0"
    WriteRegStr SHCTX "Software\Classes\.markdown" "" "Velo.md"
    ReadRegStr $0 SHCTX "Software\Classes\.mdown" ""
    WriteRegStr SHCTX "Software\Classes\.mdown" "Velo.md_backup" "$0"
    WriteRegStr SHCTX "Software\Classes\.mdown" "" "Velo.md"
    System::Call "shell32::SHChangeNotify(i,i,i,i) (0x08000000, 0x1000, 0, 0)"
  ${EndIf}

  ${If} $VeloOptFolderMenu == 1
    WriteRegStr SHCTX "Software\Classes\Directory\shell\OpenInVelo" "" "在 Velo 中打开"
    WriteRegStr SHCTX "Software\Classes\Directory\shell\OpenInVelo" "Icon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
    WriteRegStr SHCTX "Software\Classes\Directory\shell\OpenInVelo\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  ${EndIf}

  ${If} $VeloOptMdMenu == 1
    WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.md\shell\OpenInVelo" "" "在 Velo 中打开"
    WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.md\shell\OpenInVelo" "Icon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
    WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.md\shell\OpenInVelo\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
    WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.markdown\shell\OpenInVelo" "" "在 Velo 中打开"
    WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.markdown\shell\OpenInVelo" "Icon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
    WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.markdown\shell\OpenInVelo\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
    WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.mdown\shell\OpenInVelo" "" "在 Velo 中打开"
    WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.mdown\shell\OpenInVelo" "Icon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
    WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.mdown\shell\OpenInVelo\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  ${EndIf}

  WriteRegStr HKCU "Software\com.velo.editor\ShellIntegration" "DefaultOpen" "$VeloOptDefaultOpen"
  WriteRegStr HKCU "Software\com.velo.editor\ShellIntegration" "FolderMenu" "$VeloOptFolderMenu"
  WriteRegStr HKCU "Software\com.velo.editor\ShellIntegration" "MdMenu" "$VeloOptMdMenu"

!macroend
; -- PREUNINSTALL --

!macro NSIS_HOOK_PREUNINSTALL

  ClearErrors
  ReadRegStr $0 SHCTX "Software\Classes\.md" "Velo.md_backup"
  ${IfNot} ${Errors}
    WriteRegStr SHCTX "Software\Classes\.md" "" "$0"
    DeleteRegValue SHCTX "Software\Classes\.md" "Velo.md_backup"
  ${EndIf}
  ClearErrors
  ReadRegStr $0 SHCTX "Software\Classes\.markdown" "Velo.md_backup"
  ${IfNot} ${Errors}
    WriteRegStr SHCTX "Software\Classes\.markdown" "" "$0"
    DeleteRegValue SHCTX "Software\Classes\.markdown" "Velo.md_backup"
  ${EndIf}
  ClearErrors
  ReadRegStr $0 SHCTX "Software\Classes\.mdown" "Velo.md_backup"
  ${IfNot} ${Errors}
    WriteRegStr SHCTX "Software\Classes\.mdown" "" "$0"
    DeleteRegValue SHCTX "Software\Classes\.mdown" "Velo.md_backup"
  ${EndIf}
  DeleteRegKey SHCTX "Software\Classes\Velo.md"
  DeleteRegKey SHCTX "Software\Classes\Directory\shell\OpenInVelo"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInVelo"
  DeleteRegKey SHCTX "Software\Classes\SystemFileAssociations\.md\shell\OpenInVelo"
  DeleteRegKey SHCTX "Software\Classes\SystemFileAssociations\.markdown\shell\OpenInVelo"
  DeleteRegKey SHCTX "Software\Classes\SystemFileAssociations\.mdown\shell\OpenInVelo"
  System::Call "shell32::SHChangeNotify(i,i,i,i) (0x08000000, 0x1000, 0, 0)"
  DeleteRegKey HKCU "Software\com.velo.editor\ShellIntegration"

!macroend
