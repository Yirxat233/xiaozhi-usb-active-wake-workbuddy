import { mkdir, readFile, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

export interface XiaozhiEndpointStore {
  readonly kind: "windows-dpapi";
  load(): Promise<string | undefined>;
  save(endpoint: string): Promise<void>;
  clear(): Promise<void>;
}

const protectScript = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:XIAOZHI_ENDPOINT_STORE_FILE
$plain = [Console]::In.ReadToEnd()
$secure = ConvertTo-SecureString $plain -AsPlainText -Force
$protected = ConvertFrom-SecureString $secure
[IO.File]::WriteAllText($target, $protected)
`;

const unprotectScript = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:XIAOZHI_ENDPOINT_STORE_FILE
$secure = ConvertTo-SecureString ([IO.File]::ReadAllText($target))
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer))
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}
`;

const runPowerShell = (script: string, file: string, input = ""): Promise<string> => new Promise((resolveRun, reject) => {
  const childEnvironment: NodeJS.ProcessEnv = { ...process.env, XIAOZHI_ENDPOINT_STORE_FILE: file };
  // Codex/PowerShell 7 can inject a PSModulePath that is incompatible with Windows
  // PowerShell 5.1. Let powershell.exe rebuild its native module search path.
  delete childEnvironment.PSModulePath;
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    env: childEnvironment,
    stdio: "pipe",
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const timer = setTimeout(() => child.kill(), 10_000);
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.once("error", (error) => { clearTimeout(timer); reject(error); });
  child.once("exit", (code) => {
    clearTimeout(timer);
    if (code === 0) resolveRun(Buffer.concat(stdout).toString("utf8"));
    else reject(new Error(`Windows 凭据加解密失败（${code ?? "unknown"}）：${Buffer.concat(stderr).toString("utf8").trim()}`));
  });
  child.stdin.end(input);
});

export class WindowsDpapiXiaozhiEndpointStore implements XiaozhiEndpointStore {
  readonly kind = "windows-dpapi" as const;
  private readonly file: string;

  constructor(file: string) {
    this.file = resolve(file);
  }

  async load(): Promise<string | undefined> {
    try {
      await readFile(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    return runPowerShell(unprotectScript, this.file);
  }

  async save(endpoint: string): Promise<void> {
    if (process.platform !== "win32") throw new Error("DPAPI 凭据存储仅支持 Windows");
    await mkdir(dirname(this.file), { recursive: true });
    await runPowerShell(protectScript, this.file, endpoint);
  }

  async clear(): Promise<void> {
    await unlink(this.file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
