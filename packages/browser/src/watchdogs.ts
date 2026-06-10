import { join } from 'node:path';
import { createLogger } from '@accura/shared';
import type { Page } from 'playwright';
import type { CrashRecord, DialogRecord, DownloadRecord, SessionEvents } from './types.js';

const log = createLogger('browser:watchdogs');

export interface WatchdogOptions {
  /** Where downloads are saved. When unset, downloads are recorded but discarded. */
  downloadDir?: string;
  /**
   * JS dialogs must be auto-handled — an unhandled dialog freezes the page
   * and every subsequent action times out. Records are surfaced to the agent
   * in the next observation. Default: accept (agents usually want to proceed;
   * `beforeunload` is always accepted so navigation never deadlocks).
   */
  dialogPolicy?: 'accept' | 'dismiss';
}

/** Collects watchdog events between agent steps; drained once per observation. */
export class SessionEventLog {
  private dialogs: DialogRecord[] = [];
  private downloads: DownloadRecord[] = [];
  private crashes: CrashRecord[] = [];
  private popupsAdopted = 0;

  recordDialog(record: DialogRecord): void {
    this.dialogs.push(record);
  }

  recordDownload(record: DownloadRecord): void {
    this.downloads.push(record);
  }

  recordCrash(record: CrashRecord): void {
    this.crashes.push(record);
  }

  recordPopupAdopted(): void {
    this.popupsAdopted += 1;
  }

  hasCrash(): boolean {
    return this.crashes.length > 0;
  }

  drain(): SessionEvents {
    const events: SessionEvents = {
      dialogs: this.dialogs,
      downloads: this.downloads,
      crashes: this.crashes,
      popupsAdopted: this.popupsAdopted,
    };
    this.dialogs = [];
    this.downloads = [];
    this.crashes = [];
    this.popupsAdopted = 0;
    return events;
  }
}

export function attachPageWatchdogs(
  page: Page,
  events: SessionEventLog,
  options?: WatchdogOptions,
): void {
  const dialogPolicy = options?.dialogPolicy ?? 'accept';

  page.on('dialog', (dialog) => {
    const accept = dialog.type() === 'beforeunload' ? true : dialogPolicy === 'accept';
    const action = accept ? dialog.accept() : dialog.dismiss();
    action.catch(() => {
      // Dialog already handled by a racing handler — nothing to do.
    });
    events.recordDialog({
      type: dialog.type(),
      message: dialog.message(),
      handled: accept ? 'accept' : 'dismiss',
      at: Date.now(),
    });
    log.debug({ type: dialog.type(), message: dialog.message() }, 'auto-handled dialog');
  });

  page.on('download', (download) => {
    const record: DownloadRecord = {
      suggestedFilename: download.suggestedFilename(),
      at: Date.now(),
    };
    events.recordDownload(record);
    if (options?.downloadDir) {
      const target = join(options.downloadDir, download.suggestedFilename());
      download
        .saveAs(target)
        .then(() => {
          record.path = target;
        })
        .catch((error: unknown) => {
          log.warn({ error }, 'failed to save download');
        });
    }
  });

  page.on('crash', () => {
    events.recordCrash({ url: page.url(), at: Date.now() });
    log.error({ url: page.url() }, 'page crashed');
  });
}
