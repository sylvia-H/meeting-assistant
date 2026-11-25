/**
 * 資料放在哪：會議資料夾、設定資料夾（含完整 API key），以及記住這兩個位置的 location.json。
 *
 * - location.json 固定在「應用程式資料」資料夾（Windows：%APPDATA%\meeting-assistant），只存兩個路徑，不存 key。
 *   它不存在＝還沒完成第一次設定，前端會顯示引導頁。
 * - 會議預設放「文件\Meeting Assistant」，設定預設放 %APPDATA%\meeting-assistant（不會被 OneDrive 同步）。
 * - MEETING_ASSISTANT_DATA_DIR 是給 smoke／e2e 用的隔離目錄：設定與 location.json 都在那裡，視為已設定好。
 * - MEETING_ASSISTANT_APPDATA 把「應用程式資料」資料夾整個換掉（各平台都認），給 smoke-setup 隔離 location.json 用。
 */
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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
  if (process.env.MEETING_ASSISTANT_APPDATA) return path.resolve(process.env.MEETING_ASSISTANT_APPDATA);
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'meeting-assistant');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'meeting-assistant');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'meeting-assistant');
}

const locationFile = (): string => path.join(appDataDir(), 'location.json');

let shellFolders: { documents: string; desktop: string } | null = null;

type Folders = { documents?: string; desktop?: string };

/**
 * 「文件」與「桌面」的真實位置。公司電腦常被 OneDrive 轉走，不能只看 ~/Documents。
 * 先問 PowerShell；缺哪個再從登錄檔補（兩個欄位各自判斷，讀到一個就留一個）。
 */
function knownFolders(): { documents: string; desktop: string } {
  if (shellFolders) return shellFolders;
  const home = os.homedir();
  const out = { documents: path.join(home, 'Documents'), desktop: path.join(home, 'Desktop') };
  if (process.platform === 'win32') {
    let found: Folders = foldersFromPowerShell();
    if (!found.documents || !found.desktop) found = { ...foldersFromRegistry(), ...found };
    if (found.documents) out.documents = found.documents;
    if (found.desktop) out.desktop = found.desktop;
  }
  shellFolders = out;
  return out;
}

/** 看起來是完整的路徑，而且沒有解碼失敗的 U+FFFD（亂碼）。 */
const looksLikePath = (p: string | undefined): p is string =>
  typeof p === 'string' && path.win32.isAbsolute(p) && !p.includes('\uFFFD');

/** 只留下看起來正確的欄位。 */
function validFolders(documents: string | undefined, desktop: string | undefined): Folders {
  const out: Folders = {};
  if (looksLikePath(documents)) out.documents = documents;
  if (looksLikePath(desktop)) out.desktop = desktop;
  return out;
}

/** 清理用：刪不掉（被防毒或其他程式鎖住）就算了，不能蓋掉真正的結果或錯誤。 */
function removeQuietly(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // 留在暫存資料夾，系統之後會清
  }
}

/**
 * 讓 PowerShell 用 .NET 問真實位置，指定 UTF-8 輸出（reg query 的輸出是 OEM 代碼頁，繁中是 CP950，
 * 用 UTF-8 解碼會變亂碼）。被公司政策擋掉、或受限語言模式下編碼設定沒生效（輸出成亂碼）的欄位不回傳。
 */
export function foldersFromPowerShell(): Folders {
  try {
    const text = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Environment]::GetFolderPath('MyDocuments'); [Environment]::GetFolderPath('Desktop')",
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 10_000 },
    );
    const [documents, desktop] = text.split(/\r?\n/).map((line) => line.trim());
    return validFolders(documents, desktop);
  } catch {
    return {};
  }
}

/**
 * 從 reg export 的 .reg 檔內容讀出一個值。支援兩種寫法：
 * - "Personal"="C:\\Users\\x\\Documents"（REG_SZ，反斜線跳脫成兩個）
 * - "Personal"=hex(2):25,00,55,00,...（REG_EXPAND_SZ，UTF-16LE 位元組，可能用 \ 換行接續），
 *   內容裡的 %USERPROFILE% 這類變數用 env 展開
 * 找不到或格式不認得回空字串。
 */
export function parseRegValue(text: string, name: string, env: NodeJS.ProcessEnv = process.env): string {
  const lines = text.split(/\r?\n/);
  const prefix = `"${name}"=`;
  const i = lines.findIndex((line) => line.startsWith(prefix));
  if (i < 0) return '';
  let raw = (lines[i] ?? '').slice(prefix.length);
  for (let j = i; (lines[j] ?? '').endsWith('\\') && j + 1 < lines.length; j++) {
    raw = raw.slice(0, -1) + (lines[j + 1] ?? '').trim();
  }
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1).replace(/\\\\/g, '\\').replace(/\\"/g, '"');
  const hex = /^hex\(2\):([0-9a-fA-F,\s]*)$/.exec(raw);
  if (!hex) return '';
  const bytes = (hex[1] ?? '').split(',').map((b) => b.trim()).filter(Boolean).map((b) => parseInt(b, 16));
  const value = Buffer.from(bytes).toString('utf16le').replace(/\0+$/, '');
  // Windows 的環境變數不分大小寫
  const lookup = new Map(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v ?? '']));
  return value.replace(/%([^%]+)%/g, (whole, key: string) => lookup.get(key.toLowerCase()) ?? whole);
}

/** 匯出一個登錄機碼成 .reg 檔（UTF-16LE，不經過主控台代碼頁），回傳內容；失敗回空字串。 */
function exportRegistryKey(key: string): string {
  const file = path.join(os.tmpdir(), `meeting-assistant-${process.pid}-${Date.now()}.reg`);
  try {
    execFileSync('reg', ['export', key, file, '/y'], { stdio: 'ignore', windowsHide: true, timeout: 10_000 });
    return readFileSync(file, 'utf16le');
  } catch {
    return '';
  } finally {
    removeQuietly(file);
  }
}

/**
 * 備援：讀登錄檔。優先讀權威的 User Shell Folders（可能含 %USERPROFILE%，要展開），
 * 缺的再看舊版相容用的 Shell Folders。用 reg export 而不是 reg query：不用 chcp，中文不會變亂碼。
 */
export function foldersFromRegistry(): Folders {
  const base = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer';
  const user = exportRegistryKey(`${base}\\User Shell Folders`);
  let found = validFolders(parseRegValue(user, 'Personal'), parseRegValue(user, 'Desktop'));
  if (!found.documents || !found.desktop) {
    const legacy = exportRegistryKey(`${base}\\Shell Folders`);
    found = { ...validFolders(parseRegValue(legacy, 'Personal'), parseRegValue(legacy, 'Desktop')), ...found };
  }
  return found;
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

/** location.json 存在但讀不懂：不能當成「沒設定過」，否則會重跳引導頁、看起來像 key 不見了。 */
export class LocationCorruptError extends Error {}

function readLocation(): LocationFile | null {
  const file = locationFile();
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as LocationFile;
  } catch {
    throw new LocationCorruptError(
      `${file} 內容損壞，讀不出會議與設定資料夾的位置。請用文字編輯器修正，或刪掉它後重新整理（會重新選位置，原本的資料不會被刪）。`,
    );
  }
}

/** 第一次設定（選兩個位置）完成了沒有。測試模式一律算完成；檔案損壞也算「設定過」，交給讀取時報錯。 */
export function isConfigured(): boolean {
  return Boolean(testDataDir) || existsSync(locationFile());
}

/** 測試模式：設定資料夾固定在 MEETING_ASSISTANT_DATA_DIR，不看 location.json，不能搬。 */
export const isTestMode = (): boolean => Boolean(testDataDir);

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
  // 先寫暫存檔再改名：寫到一半被關掉也不會留下半個檔
  const file = locationFile();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
  } catch (err) {
    removeQuietly(tmp);
    throw err;
  }
}

/** 比對路徑用：去掉尾端分隔符號；Windows／Mac 的檔案系統不分大小寫，Linux 分。 */
export const norm = (p: string): string => {
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
 * 搬設定檔的第一步：把 settings.json、.env 複製到新資料夾並比對內容，回傳複製了哪些。
 * 目的地已有同名檔時不覆蓋，直接丟錯，避免蓋掉別份 key。任何一個失敗就把已複製的清掉，舊檔不動。
 * 舊檔要等 location.json 改指新位置之後才刪（removeSettingsFiles），中途失敗 key 也不會消失。
 */
export function copySettingsFiles(from: string, to: string): string[] {
  if (norm(from) === norm(to)) return [];
  const moving = SETTINGS_FILES.filter((name) => existsSync(path.join(from, name)));
  const clash = moving.filter((name) => existsSync(path.join(to, name)));
  if (clash.length) {
    throw new Error(`新位置已經有 ${clash.join('、')}，為了不蓋掉其他設定，沒有搬移。請換一個空的資料夾，或先自己處理那些檔案。`);
  }
  const copied: string[] = [];
  try {
    for (const name of moving) {
      const src = path.join(from, name);
      const dst = path.join(to, name);
      // 先記下再複製：複製到一半失敗時，殘缺的目的檔也要清掉（衝突檢查已確認目的地原本沒有它）
      copied.push(name);
      copyFileSync(src, dst);
      if (!readFileSync(dst).equals(readFileSync(src))) throw new Error(`複製 ${name} 後內容不一致，沒有搬移`);
    }
  } catch (err) {
    // 清理失敗不能蓋掉真正的錯誤原因；清不掉的留著，下次衝突檢查會提示
    removeSettingsFiles(to, copied);
    throw err;
  }
  return moving;
}

/** 搬設定檔的最後一步：刪掉舊位置的檔。刪不掉的回傳檔名，讓呼叫端提示使用者自己刪（新位置已經生效）。 */
export function removeSettingsFiles(dir: string, names: string[]): string[] {
  const left: string[] = [];
  for (const name of names) {
    try {
      rmSync(path.join(dir, name), { force: true });
    } catch {
      left.push(name);
    }
  }
  return left;
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
