export interface ScreenshotResult {
  data: Buffer;
  /** Actual pixel dimensions parsed from the encoded image — never assumed. */
  width: number;
  height: number;
}

export interface TabInfo {
  index: number;
  url: string;
  title: string;
  active: boolean;
}

export interface DialogRecord {
  type: string;
  message: string;
  handled: 'accept' | 'dismiss';
  at: number;
}

export interface DownloadRecord {
  suggestedFilename: string;
  path?: string;
  at: number;
}

export interface CrashRecord {
  url: string;
  at: number;
}

/** Drained once per agent step and surfaced in the observation. */
export interface SessionEvents {
  dialogs: DialogRecord[];
  downloads: DownloadRecord[];
  crashes: CrashRecord[];
  popupsAdopted: number;
}

export interface StabilityOptions {
  timeoutMs?: number;
  /** Window with zero DOM mutations required twice in a row. */
  mutationWindowMs?: number;
  /** Cap for the network-quiet wait specifically. */
  networkQuietTimeoutMs?: number;
}

export interface StabilityReport {
  domContentLoaded: boolean;
  networkQuiet: boolean;
  domStable: boolean;
  elapsedMs: number;
}
