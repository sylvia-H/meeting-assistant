/**
 * 資料放在哪：會議資料夾、設定資料夾（含完整 API key），以及記住這兩個位置的 location.json。
 *
 * - location.json 固定在「應用程式資料」資料夾（Windows：%APPDATA%\meeting-assistant），只存兩個路徑，不存 key。
 *   它不存在＝還沒完成第一次設定，前端會顯示引導頁。
 * - 會議預設放「文件\Meeting Assistant」，設定預設放 %APPDATA%\meeting-assistant（不會被 OneDrive 同步）。
 * - MEETING_ASSISTANT_DATA_DIR 是給 smoke／e2e 用的隔離目錄：設定與 location.json 都在那裡，視為已設定好。
 */
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSea } from 'node:sea';

export const runningAsExe = isSea();

/** 原始碼根目錄（dist、tools 在這裡）；exe 版是 exe 所在的資料夾。 */
export const projectRoot = runningAsExe ? path.dirname(process.execPath) : path.resolve(import.meta.dirname, '..');

const testDataDir = process.env.MEETING_ASSISTANT_DATA_DIR ? path.resolve(process.env.MEETING_ASSISTANT_DATA_DIR) : '';

/** 作業系統慣例的「應用程式資料」資料夾，location.json 與預設的設定都放這裡。 */
export function appDataDir(): string {
  if (testDataDir) return testDataDir;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'meeting-assistant');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'meeting-assistant');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'meeting-assistant');
}

const locationFile = (): string => path.join(appDataDir(), 'location.json');

let shellFolders: { documents: string; desktop: string } | null = null;

/** 「文件」與「桌面」的真實位置。公司電腦常被 OneDrive 轉走，不能只看 ~/Documents。 */
function knownFolders(): { documents: string; desktop: string } {
  if (shellFolders) return shellFolders;
  const home = os.homedir();
  const out = { documents: path.join(home, 'Documents'), desktop: path.join(home, 'Desktop') };
  if (process.platform === 'win32') {
    const read = (name: string): string => {
      try {
        const text = execFileSync(
          'reg',
          ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders', '/v', name],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
        );
        return /REG_SZ\s+(.+)/.exec(text)?.[1]?.trim() ?? '';
      } catch {
        return '';
      }
    };
    out.documents = read('Personal') || out.documents;
    out.desktop = read('Desktop') || out.desktop;
  }
  shellFolders = out;
  return out;
}

export interface LocationDefaults {
  meetingsDir: string;
  settingsDir: string;
}

export function defaultLocations(): LocationDefaults {
  return {
    meetingsDir: path.join(knownFolders().documents, 'Meeting Assistant'),
    settingsDir: appDataDir(),
  };
}

interface LocationFile {
  meetingsDir?: string;
  settingsDir?: string;
}

function readLocation(): LocationFile | null {
  const file = locationFile();
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as LocationFile;
  } catch {
    return null;
  }
}

/** 第一次設定（選兩個位置）完成了沒有。測試模式一律算完成。 */
export function isConfigured(): boolean {
  return Boolean(testDataDir) || readLocation() !== null;
}

/** 設定資料夾（settings.json、.env 在這裡）。 */
export function settingsDir(): string {
  if (testDataDir) return testDataDir;
  return readLocation()?.settingsDir || defaultLocations().settingsDir;
}

/** location.json 記的會議資料夾；沒記（測試模式、舊資料）回空字串，由設定檔決定。 */
export function locatedMeetingsDir(): string {
  return readLocation()?.meetingsDir ?? '';
}

export function writeLocation(next: LocationFile): void {
  const merged = { ...(readLocation() ?? {}), ...next };
  mkdirSync(appDataDir(), { recursive: true });
  writeFileSync(locationFile(), `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
}

const norm = (p: string): string => {
  const out = path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' || process.platform === 'darwin' ? out.toLowerCase() : out;
};

const isInside = (child: string, parent: string): boolean => {
  if (!parent) return false;
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(`${p}${path.sep}`);
};

/**
 * 這個位置是否可能被同步到雲端：「文件」、「桌面」、任何 OneDrive 資料夾（Mac 另含 iCloud）。
 * 只是提示，不擋存檔。
 */
export function cloudRisk(dir: string): string | null {
  if (!dir.trim()) return null;
  const { documents, desktop } = knownFolders();
  const home = os.homedir();
  const oneDrives = [process.env.OneDrive, process.env.OneDriveCommercial, process.env.OneDriveConsumer].filter(
    (v): v is string => Boolean(v),
  );
  if (oneDrives.some((root) => isInside(dir, root)) || path.resolve(dir).split(path.sep).some((part) => /^onedrive\b/i.test(part))) {
    return '這個位置在 OneDrive 裡，裡面的檔案會被上傳到雲端。';
  }
  if (process.platform === 'darwin' && (isInside(dir, path.join(home, 'Library', 'Mobile Documents')) || isInside(dir, path.join(home, 'Library', 'CloudStorage')))) {
    return '這個位置在 iCloud 或雲端硬碟裡，裡面的檔案會被上傳到雲端。';
  }
  for (const [label, root] of [
    ['文件', documents],
    ['桌面', desktop],
    ['文件', path.join(home, 'Documents')],
    ['桌面', path.join(home, 'Desktop')],
  ] as const) {
    if (isInside(dir, root)) return `這個位置在「${label}」資料夾裡。公司電腦常把「${label}」同步到 OneDrive，裡面的檔案可能被上傳到雲端。`;
  }
  return null;
}

/** 建立資料夾並試寫一個檔；失敗丟出看得懂的錯誤。 */
export function ensureWritable(dir: string, label: string): string {
  const trimmed = dir.trim();
  if (!trimmed) throw new Error(`${label}不能留白`);
  if (!path.isAbsolute(trimmed)) throw new Error(`${label}要填完整路徑（例如 D:\\會議紀錄）`);
  const abs = path.resolve(trimmed);
  const probe = path.join(abs, `.write-test-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(abs, { recursive: true });
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    const why = code === 'EACCES' || code === 'EPERM' ? '沒有寫入權限' : code === 'ENOENT' ? '磁碟或上層路徑不存在' : code || '無法寫入';
    throw new Error(`${label}無法使用：${abs}（${why}）。請換一個位置。`);
  }
  return abs;
}

const SETTINGS_FILES = ['settings.json', '.env'];

/**
 * 把設定檔（settings.json、.env）搬到新資料夾：先複製、確認讀得到內容一致，再刪舊的。
 * 目的地已有同名檔時不覆蓋，直接丟錯，避免蓋掉別份 key。
 */
export function moveSettingsFiles(from: string, to: string): string[] {
  if (norm(from) === norm(to)) return [];
  const moving = SETTINGS_FILES.filter((name) => existsSync(path.join(from, name)));
  const clash = moving.filter((name) => existsSync(path.join(to, name)));
  if (clash.length) {
    throw new Error(`新位置已經有 ${clash.join('、')}，為了不蓋掉其他設定，沒有搬移。請換一個空的資料夾，或先自己處理那些檔案。`);
  }
  for (const name of moving) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    copyFileSync(src, dst);
    if (!readFileSync(dst).equals(readFileSync(src))) {
      rmSync(dst, { force: true });
      throw new Error(`複製 ${name} 後內容不一致，沒有搬移`);
    }
  }
  for (const name of moving) rmSync(path.join(from, name), { force: true });
  return moving;
}

/** 從原始碼執行時，專案資料夾裡還留著改版前的資料，啟動時提醒要手動搬哪些檔。 */
export function legacyDataHints(): string[] {
  if (runningAsExe || testDataDir) return [];
  const out: string[] = [];
  const oldSettings = path.join(projectRoot, 'server', '.data', 'settings.json');
  if (existsSync(oldSettings)) out.push(`${oldSettings} → 搬到設定資料夾 ${settingsDir()}`);
  const oldEnv = path.join(projectRoot, '.env');
  if (existsSync(oldEnv)) out.push(`${oldEnv} → 搬到設定資料夾 ${settingsDir()}`);
  const oldMeetings = path.join(projectRoot, 'meetings');
  if (existsSync(oldMeetings)) out.push(`${oldMeetings}\\* → 每場會議的資料夾搬到會議資料夾`);
  return out;
}

/**
 * Windows 的選資料夾視窗。
 *
 * Windows PowerShell 5.1 的 FolderBrowserDialog 只會出 XP 時代的樹狀小視窗，所以直接呼叫
 * Vista 以後的 IFileOpenDialog（FOS_PICKFOLDERS）：跟瀏覽器夾帶檔案時同一個檔案總管視窗，
 * 有網址列、搜尋、側邊欄、「新增資料夾」。C# 由 Add-Type 即時編譯，第一次約多 1 秒；
 * 編譯或 COM 失敗就退回舊的 FolderBrowserDialog，至少還選得了。
 * 視窗掛在 TopMost 的隱形視窗下，才不會被瀏覽器蓋住。
 */
const WINDOWS_PICKER_CS = String.raw`
using System;
using System.Runtime.InteropServices;

public static class MaFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
  private class FileOpenDialogCom {}

  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr hwndOwner);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
  }

  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  private static extern void SHCreateItemFromParsingName(
    string pszPath, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem ppv);

  private const uint FOS_PICKFOLDERS = 0x20;
  private const uint FOS_FORCEFILESYSTEM = 0x40;
  private const uint FOS_PATHMUSTEXIST = 0x800;
  private const uint SIGDN_FILESYSPATH = 0x80058000;
  private const int ERROR_CANCELLED = unchecked((int)0x800704C7);

  // 回傳選到的路徑；按取消回空字串
  public static string Pick(IntPtr owner, string title, string initial) {
    IFileOpenDialog dlg = (IFileOpenDialog)new FileOpenDialogCom();
    try {
      uint options;
      dlg.GetOptions(out options);
      dlg.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
      if (!string.IsNullOrEmpty(title)) dlg.SetTitle(title);
      if (!string.IsNullOrEmpty(initial)) {
        try {
          IShellItem folder;
          SHCreateItemFromParsingName(initial, IntPtr.Zero, typeof(IShellItem).GUID, out folder);
          dlg.SetFolder(folder);
        } catch {
          // 起始資料夾設不了就從預設位置開始
        }
      }
      int hr = dlg.Show(owner);
      if (hr == ERROR_CANCELLED) return "";
      if (hr != 0) Marshal.ThrowExceptionForHR(hr);
      IShellItem result;
      dlg.GetResult(out result);
      string path;
      result.GetDisplayName(SIGDN_FILESYSPATH, out path);
      return path;
    } finally {
      Marshal.ReleaseComObject(dlg);
    }
  }
}
`;

const WINDOWS_PICKER_SCRIPT = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Windows.Forms',
  '$owner = New-Object System.Windows.Forms.Form',
  '$owner.TopMost = $true',
  '$owner.ShowInTaskbar = $false',
  '$owner.StartPosition = "CenterScreen"',
  '$owner.Size = New-Object System.Drawing.Size(1,1)',
  '$owner.Show()',
  '$owner.Activate()',
  '$initial = ""',
  'if ($env:MA_PICK_INITIAL -and (Test-Path -LiteralPath $env:MA_PICK_INITIAL)) { $initial = $env:MA_PICK_INITIAL }',
  '$picked = $null',
  'try {',
  '  Add-Type -TypeDefinition $env:MA_PICK_CS -Language CSharp -ErrorAction Stop',
  '  $picked = [MaFolderPicker]::Pick($owner.Handle, $env:MA_PICK_TITLE, $initial)',
  '} catch {',
  '  # 新版視窗開不了：退回舊的樹狀視窗',
  '  $dlg = New-Object System.Windows.Forms.FolderBrowserDialog',
  '  $dlg.Description = $env:MA_PICK_TITLE',
  '  $dlg.ShowNewFolderButton = $true',
  '  if ($initial) { $dlg.SelectedPath = $initial }',
  '  if ($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $picked = $dlg.SelectedPath }',
  '}',
  '$owner.Close()',
  'if ($picked) { Write-Output $picked }',
].join('\n');

/**
 * 叫出系統原生的「選擇資料夾」視窗（瀏覽器網頁拿不到完整路徑，只好由本機伺服器開）。
 * 使用者按取消回 null。
 */
export function pickFolder(initial: string, title: string): Promise<string | null> {
  if (process.platform === 'win32') {
    const encoded = Buffer.from(WINDOWS_PICKER_SCRIPT, 'utf16le').toString('base64');
    return runPicker('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-EncodedCommand', encoded], {
      MA_PICK_TITLE: title,
      MA_PICK_INITIAL: nearestExisting(initial),
      // C# 原始碼走環境變數，不塞進命令列（-EncodedCommand 有長度上限）
      MA_PICK_CS: WINDOWS_PICKER_CS,
    });
  }
  if (process.platform === 'darwin') {
    const start = nearestExisting(initial);
    const script = `POSIX path of (choose folder with prompt ${JSON.stringify(title)}${start ? ` default location (POSIX file ${JSON.stringify(start)})` : ''})`;
    return runPicker('osascript', ['-e', script], {});
  }
  return runPicker('zenity', ['--file-selection', '--directory', `--title=${title}`], {});
}

/** 預設路徑通常還沒建立，往上找到存在的那一層給視窗當起點。 */
function nearestExisting(dir: string): string {
  let cur = dir.trim() ? path.resolve(dir) : '';
  while (cur && !existsSync(cur)) {
    const up = path.dirname(cur);
    if (up === cur) return '';
    cur = up;
  }
  return cur;
}

function runPicker(command: string, args: string[], env: Record<string, string>): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
    child.on('error', () => reject(new Error('這台電腦開不了選擇資料夾的視窗，請直接在欄位裡輸入完整路徑。')));
    child.on('close', (code) => {
      const raw = out.trim();
      // Mac 的 POSIX path 尾端帶 /；磁碟根目錄（C:\、/）保留
      const picked = raw.length > 3 ? raw.replace(/[\\/]$/, '') : raw;
      if (picked) resolve(picked);
      // osascript 按取消回 code 1；其他非零才算真的失敗
      else if (code === 0 || (command === 'osascript' && /-128/.test(err)) || (command === 'zenity' && code === 1)) resolve(null);
      else reject(new Error(`選擇資料夾的視窗開啟失敗：${err.trim() || `code ${code}`}`));
    });
  });
}
