; Velo NSIS Installer Hooks
;
; ProgID + folder/md context menu managed by hooks
; installMode=currentUser: SHCTX=HKCU

Var VeloChkMenu
Var VeloChkMdMenu
Var VeloOptFolderMenu
Var VeloOptMdMenu

; -- Additional Tasks --

Function PageTasks
  ${If} $PassiveMode = 1
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
  ${NSD_CreateCheckbox} 0 10u 100% 12u '添加"在 Velo 中打开"到文件夹右键菜单'
  Pop $VeloChkMenu
  ${NSD_SetState} $VeloChkMenu ${BST_CHECKED}
  ${NSD_CreateCheckbox} 0 30u 100% 12u '添加"在 Velo 中打开"到 Markdown 文件右键菜单'
  Pop $VeloChkMdMenu
  ${NSD_SetState} $VeloChkMdMenu ${BST_CHECKED}
  nsDialogs::Show
FunctionEnd

Function LeaveTasks
  ${NSD_GetState} $VeloChkMenu $VeloOptFolderMenu
  ${NSD_GetState} $VeloChkMdMenu $VeloOptMdMenu
FunctionEnd

; -- 顶层定义(不能嵌套在 !macro 内部) --

; Capabilities + 右键菜单共用的字面模板。$INSTDIR / ${MAINBINARYNAME} 在安装时展开。
!define VeloMdProgId "Velo.md"
!define VeloMdVerbIcon "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
!define VeloMdVerbCmd "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""

; 注册一个 Capabilities\FileAssociations 条目:扩展名 → ProgID。
!macro VELO_CAP_EXT EXTOUT
  WriteRegStr SHCTX "Software\Velo\Capabilities\FileAssociations" "${EXTOUT}" "${VeloMdProgId}"
!macroend

; 注册一个 md 扩展名的 SystemFileAssociations 右键 verb(含 Icon + command)。
!macro VELO_MD_VERB EXTOUT
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\${EXTOUT}\shell\OpenInVelo" "" "在 Velo 中打开"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\${EXTOUT}\shell\OpenInVelo" "Icon" "${VeloMdVerbIcon}"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\${EXTOUT}\shell\OpenInVelo\command" "" "${VeloMdVerbCmd}"
!macroend

; 卸载:清一个 md 扩展名的右键 verb,HKCU(SHCTX) + HKLM 双侧(command 先、verb 后)。
!macro VELO_DEL_MD_VERB EXTOUT
  DeleteRegKey SHCTX "Software\Classes\SystemFileAssociations\${EXTOUT}\shell\OpenInVelo\command"
  DeleteRegKey SHCTX "Software\Classes\SystemFileAssociations\${EXTOUT}\shell\OpenInVelo"
  DeleteRegKey HKLM  "Software\Classes\SystemFileAssociations\${EXTOUT}\shell\OpenInVelo\command"
  DeleteRegKey HKLM  "Software\Classes\SystemFileAssociations\${EXTOUT}\shell\OpenInVelo"
!macroend

; -- POSTINSTALL --

!macro NSIS_HOOK_POSTINSTALL

  ${If} $PassiveMode = 1
    StrCpy $VeloOptFolderMenu 1
    StrCpy $VeloOptMdMenu 1
  ${EndIf}

  WriteRegStr SHCTX "Software\Classes\Velo.md" "" "Markdown 文档"
  WriteRegStr SHCTX "Software\Classes\Velo.md\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr SHCTX "Software\Classes\Velo.md\shell" "" "open"
  WriteRegStr SHCTX "Software\Classes\Velo.md\shell\open" "" "Open with Velo"
  WriteRegStr SHCTX "Software\Classes\Velo.md\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""

  ; 注册 RegisteredApplications + Capabilities —— 让 Velo 出现在 Windows
  ; "设置 > 默认应用" 列表中。始终注册,与用户是否勾选设为默认无关。
  WriteRegStr SHCTX "Software\RegisteredApplications" "Velo" "Software\Velo\Capabilities"
  WriteRegStr SHCTX "Software\Velo\Capabilities" "ApplicationName" "Velo"
  WriteRegStr SHCTX "Software\Velo\Capabilities" "ApplicationDescription" "Markdown 编辑器"
  ; Capabilities\FileAssociations:把全部 Markdown 扩展名都指向 ProgID Velo.md,
  ; 让 Velo 出现在 Windows "设置 > 默认应用" 列表中、所有 md 类文件都认。
  ; (VELO_CAP_EXT 宏 + VeloMdProgId 等在文件顶层定义)
  !insertmacro VELO_CAP_EXT ".md"
  !insertmacro VELO_CAP_EXT ".markdown"
  !insertmacro VELO_CAP_EXT ".mdown"
  !insertmacro VELO_CAP_EXT ".mkd"
  !insertmacro VELO_CAP_EXT ".mkdown"
  !insertmacro VELO_CAP_EXT ".mdwn"
  !insertmacro VELO_CAP_EXT ".mdtxt"
  !insertmacro VELO_CAP_EXT ".mdtext"

  ${If} $VeloOptFolderMenu == 1
    WriteRegStr SHCTX "Software\Classes\Directory\shell\OpenInVelo" "" "在 Velo 中打开"
    WriteRegStr SHCTX "Software\Classes\Directory\shell\OpenInVelo" "Icon" "${VeloMdVerbIcon}"
    WriteRegStr SHCTX "Software\Classes\Directory\shell\OpenInVelo\command" "" "${VeloMdVerbCmd}"
  ${EndIf}

  ; md 文件右键菜单:为全部 Markdown 扩展名各注册一个 SystemFileAssociations verb。
  ; (VELO_MD_VERB 宏 + VeloMd* 字面在文件顶层定义)
  ${If} $VeloOptMdMenu == 1
    !insertmacro VELO_MD_VERB ".md"
    !insertmacro VELO_MD_VERB ".markdown"
    !insertmacro VELO_MD_VERB ".mdown"
    !insertmacro VELO_MD_VERB ".mkd"
    !insertmacro VELO_MD_VERB ".mkdown"
    !insertmacro VELO_MD_VERB ".mdwn"
    !insertmacro VELO_MD_VERB ".mdtxt"
    !insertmacro VELO_MD_VERB ".mdtext"
  ${EndIf}

  WriteRegStr HKCU "Software\com.velo.editor\ShellIntegration" "FolderMenu" "$VeloOptFolderMenu"
  WriteRegStr HKCU "Software\com.velo.editor\ShellIntegration" "MdMenu" "$VeloOptMdMenu"

!macroend
; -- PREUNINSTALL --

!macro NSIS_HOOK_PREUNINSTALL

  ; 清理文件关联注册
  DeleteRegKey SHCTX "Software\Classes\Velo.md"
  ; 清理 RegisteredApplications + Capabilities
  DeleteRegValue SHCTX "Software\RegisteredApplications" "Velo"
  DeleteRegKey SHCTX "Software\Velo"

  ; 清理右键菜单。NSIS DeleteRegKey 只能删无子键的键,OpenInVelo 下有 command 子键,
  ; 必须先删 command 再删 OpenInVelo(自底向上),否则 verb 键会因残留子键而删不掉。
  ; 清两趟:key = SHCTX(HKCU,per-user) + HKLM(旧 per-machine 残留,无管理员权限时静默跳过)。
  ; (VELO_DEL_MD_VERB 宏在文件顶层定义)

  DeleteRegKey SHCTX "Software\Classes\Directory\shell\OpenInVelo\command"
  DeleteRegKey SHCTX "Software\Classes\Directory\shell\OpenInVelo"
  DeleteRegKey HKLM  "Software\Classes\Directory\shell\OpenInVelo\command"
  DeleteRegKey HKLM  "Software\Classes\Directory\shell\OpenInVelo"

  !insertmacro VELO_DEL_MD_VERB ".md"
  !insertmacro VELO_DEL_MD_VERB ".markdown"
  !insertmacro VELO_DEL_MD_VERB ".mdown"
  !insertmacro VELO_DEL_MD_VERB ".mkd"
  !insertmacro VELO_DEL_MD_VERB ".mkdown"
  !insertmacro VELO_DEL_MD_VERB ".mdwn"
  !insertmacro VELO_DEL_MD_VERB ".mdtxt"
  !insertmacro VELO_DEL_MD_VERB ".mdtext"

  System::Call "shell32::SHChangeNotify(i,i,i,i) (0x08000000, 0x1000, 0, 0)"
  DeleteRegKey HKCU "Software\com.velo.editor\ShellIntegration"

!macroend
