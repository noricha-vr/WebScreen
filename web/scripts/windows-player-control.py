#!/usr/bin/env python3
"""既存 SSH と一時対話タスクで VRChat を操作する（常駐不要）。

choicast/scripts/windows-player-control.py の方式を WebScreen 用に移植。
接続先は VRCHAT_SSH_HOST のみ。手順は docs/windows-vrchat-verification.md。
"""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import uuid

def ssh_host():
    host = os.environ.get('VRCHAT_SSH_HOST', '')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', host):
        raise ValueError('VRCHAT_SSH_HOST に SSH ホスト名を設定してください: export VRCHAT_SSH_HOST=<SSHホスト名>')
    return host


def ssh_command():
    return ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', ssh_host()]


def scp_command():
    return ['scp', '-O', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8']

KEYS = {'w': 0x11, 'a': 0x1e, 's': 0x1f, 'd': 0x20, 'escape': 1,
        'enter': 0x1c, 'tab': 0x0f, 'e': 0x12, 'space': 0x39, 'backspace': 0x0e}
NATIVE = r'''
Add-Type @'
using System; using System.Runtime.InteropServices;
public class CI {
[StructLayout(LayoutKind.Sequential)] public struct INPUT {public uint type; public UNION u;}
[StructLayout(LayoutKind.Explicit)] public struct UNION {[FieldOffset(0)] public KEY ki; [FieldOffset(0)] public MOUSE mi;}
[StructLayout(LayoutKind.Sequential)] public struct KEY {public ushort vk,scan;public uint flags,time;public UIntPtr extra;}
[StructLayout(LayoutKind.Sequential)] public struct MOUSE {public int x,y;public uint data,flags,time;public UIntPtr extra;}
[DllImport("user32.dll")] static extern uint SendInput(uint n,INPUT[] i,int size);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
public static void Key(ushort scan,bool up){var i=new INPUT{type=1};i.u.ki.scan=scan;i.u.ki.flags=(uint)(8+(up?2:0));Send(i);}
public static void Mouse(int x,int y,uint flags){var i=new INPUT{type=0};i.u.mi.x=x;i.u.mi.y=y;i.u.mi.flags=flags;Send(i);}
static void Send(INPUT i){if(SendInput(1,new[]{i},Marshal.SizeOf(typeof(INPUT)))!=1)throw new Exception("SendInput failed");}
}
'@
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
'''
FOCUS = r'''
$p=Get-Process VRChat -ErrorAction Stop | Select-Object -First 1
if($p.SessionId -ne (Get-Process -Id $PID).SessionId){throw 'VRChat is in another session'}
if($p.MainWindowHandle -eq 0){throw 'VRChat window is not ready'}
[CI]::ShowWindow($p.MainWindowHandle,3) | Out-Null
$w=New-Object -ComObject WScript.Shell
$w.AppActivate($p.Id) | Out-Null
Start-Sleep -Milliseconds 700
if([CI]::GetForegroundWindow() -ne $p.MainWindowHandle){throw 'VRChat could not be focused; no input sent'}
'''
SCREENSHOT = r'''
Start-Sleep -Milliseconds 500
$b=[Windows.Forms.SystemInformation]::VirtualScreen
$bmp=New-Object Drawing.Bitmap $b.Width,$b.Height
$g=[Drawing.Graphics]::FromImage($bmp)
try {$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size);$bmp.Save((Join-Path $PSScriptRoot 'screen.png'))}
finally {$g.Dispose();$bmp.Dispose()}
'''


def ps_literal(value):
    return "'" + value.replace("'", "''") + "'"


def powershell(script):
    encoded = base64.b64encode(("$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);" + script).encode('utf-16le')).decode()
    result = subprocess.run(ssh_command() + ['powershell -NoProfile -EncodedCommand ' + encoded],
                            capture_output=True, timeout=55)
    if result.returncode:
        raise RuntimeError(result.stderr.decode('utf-8', errors='replace'))
    return result.stdout.decode('utf-8-sig').strip()


def action_script(args):
    if args.command == 'launch':
        return "Start-Process ((Get-ItemProperty 'HKCU:\\Software\\Valve\\Steam').SteamPath + '/steam.exe') -ArgumentList '-applaunch 438100 --no-vr'"
    body = NATIVE + FOCUS
    if args.command == 'key':
        body += f'\n[CI]::Key({KEYS[args.key]},$false);try{{Start-Sleep -Milliseconds {args.ms}}}finally{{[CI]::Key({KEYS[args.key]},$true)}}\n'
    elif args.command == 'look':
        body += f'\n[CI]::Mouse({args.dx},{args.dy},1)\n'
    elif args.command == 'click':
        body += f'\n$b=[Windows.Forms.SystemInformation]::VirtualScreen;if({args.x} -lt $b.Left -or {args.y} -lt $b.Top -or {args.x} -ge $b.Right -or {args.y} -ge $b.Bottom){{throw "Coordinates outside desktop"}};[CI]::SetCursorPos({args.x},{args.y}) | Out-Null;Start-Sleep -Milliseconds 500;[CI]::Mouse(0,0,2);try{{Start-Sleep -Milliseconds 100}}finally{{[CI]::Mouse(0,0,4)}}\n'
    elif args.command in ('paste-url', 'search-text'):
        body += '[CI]::Key(0x1d,$false);try{[CI]::Key(0x1e,$false);Start-Sleep -Milliseconds 100;[CI]::Key(0x1e,$true)}finally{[CI]::Key(0x1e,$true);[CI]::Key(0x1d,$true)}\n'
        value = args.url if args.command == 'paste-url' else args.text
        body += f'\n[Windows.Forms.Clipboard]::SetText({ps_literal(value)})\n'
        body += '[CI]::Key(0x1d,$false);try{[CI]::Key(0x2f,$false);Start-Sleep -Milliseconds 100;[CI]::Key(0x2f,$true)}finally{[CI]::Key(0x2f,$true);[CI]::Key(0x1d,$true)}\n'
    return body + SCREENSHOT


def run_interactive(args):
    run_id = 'WebScreenControl-' + uuid.uuid4().hex
    remote_root = powershell("Join-Path $env:TEMP " + ps_literal(run_id))
    if not re.fullmatch(r'[A-Za-z]:\\[\w .\\-]+', remote_root):
        raise RuntimeError('Unexpected Windows TEMP path')
    root = ps_literal(remote_root)
    task = ps_literal(run_id)
    # Result marker, not a task state transition, proves the action completed.
    script = "$ErrorActionPreference='Stop';try {\n" + action_script(args) + r'''
@{ok=$true} | ConvertTo-Json | Set-Content (Join-Path $PSScriptRoot 'result.json')
} catch {
@{ok=$false;error=$_.Exception.Message} | ConvertTo-Json | Set-Content (Join-Path $PSScriptRoot 'result.json')
exit 1
}
'''
    try:
        powershell(f'New-Item -ItemType Directory -Path {root} | Out-Null')
        with tempfile.TemporaryDirectory(prefix='webscreen-control-') as temp:
            source = Path(temp) / 'action.ps1'
            source.write_text(script, encoding='utf-8-sig')
            subprocess.run(scp_command() + [str(source), ssh_host() + ':' + remote_root.replace('\\', '/') + '/action.ps1'], check=True, capture_output=True, timeout=20)
        start = f'''$root={root};$task={task};$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -File "' + $root + '\\action.ps1"');$p=New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited;Register-ScheduledTask -TaskName $task -Action $a -Principal $p | Out-Null;Start-ScheduledTask -TaskName $task;for($i=0;$i -lt 30;$i++){{if(Test-Path ($root+'\\result.json')){{Get-Content -Raw ($root+'\\result.json');exit 0}};Start-Sleep 1}};throw 'Interactive action timed out (locked or disconnected desktop?)' '''
        result = json.loads(powershell(start))
        if not result['ok']:
            raise RuntimeError(result['error'])
        if args.command != 'launch':
            output = Path(args.out).resolve()
            output.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(scp_command() + [ssh_host() + ':' + remote_root.replace('\\', '/') + '/screen.png', str(output)], check=True, capture_output=True, timeout=20)
            print(output)
        else:
            print('Steam launch requested; verify with snapshot.')
    finally:
        powershell(f'if(Get-ScheduledTask -TaskName {task} -ErrorAction SilentlyContinue){{Stop-ScheduledTask -TaskName {task} -ErrorAction Stop;Unregister-ScheduledTask -TaskName {task} -Confirm:$false -ErrorAction Stop}};if(Test-Path -LiteralPath {root}){{Remove-Item -LiteralPath {root} -Recurse -Force -ErrorAction Stop}}')


def bounded_integer(low, high):
    def parse(value):
        number = int(value)
        if not low <= number <= high:
            raise argparse.ArgumentTypeError(f'must be {low}..{high}')
        return number
    return parse


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('status')
    sub.add_parser('launch')
    for name in ['snapshot', 'key', 'look', 'click', 'paste-url', 'search-text']:
        item = sub.add_parser(name)
        item.add_argument('--out', default='docs/tmp/windows-player/screen.png')
        if name == 'key':
            item.add_argument('key', choices=KEYS)
            item.add_argument('--ms', type=bounded_integer(20, 5000), default=80)
        elif name == 'look':
            item.add_argument('dx', type=bounded_integer(-2000, 2000))
            item.add_argument('dy', type=bounded_integer(-2000, 2000))
        elif name == 'click':
            item.add_argument('x', type=int)
            item.add_argument('y', type=int)
        elif name == 'paste-url':
            item.add_argument('url')
        elif name == 'search-text':
            item.add_argument('text')
    args = parser.parse_args(argv)
    if args.command == 'search-text' and not re.fullmatch(r'[A-Za-z0-9 -]{1,80}', args.text):
        parser.error('Search text must be 1..80 ASCII letters, digits, spaces or hyphens')
    if args.command == 'paste-url' and not re.fullmatch(r'https://cdn\.web-screen\.net/movies/[A-Za-z0-9]{12}\.mp4', args.url):
        parser.error('URL must be https://cdn.web-screen.net/movies/{12-character ID}.mp4')
    return args


def main():
    args = parse_args()
    ssh_host()  # 接続・一時ファイル作成前に必ず検証する
    if args.command == 'status':
        print(powershell(r'''$os=Get-CimInstance Win32_OperatingSystem;@{os=$os.Caption;freeCommitKb=$os.FreeVirtualMemory;processes=@(Get-Process VRChat,explorer,LogonUI -ErrorAction SilentlyContinue | Select-Object ProcessName,Id,SessionId);tasks=@(Get-ScheduledTask | Where-Object TaskName -Like 'WebScreenControl-*' | Select-Object TaskName,State)} | ConvertTo-Json -Depth 4'''))
    else:
        run_interactive(args)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as error:
        raise SystemExit(f'Windows 操作失敗: {error}') from None
