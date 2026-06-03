$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut("C:\Users\10990\Desktop\VibeBoard.lnk")
$Shortcut.TargetPath = "C:\tmp\vibeboard-linux-prototype\start.bat"
$Shortcut.WorkingDirectory = "C:\tmp\vibeboard-linux-prototype"
$Shortcut.Save()
