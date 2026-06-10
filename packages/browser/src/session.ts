import { BrowserError, createLogger, type BrowserConfig } from '@accura/shared';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright';
import { takeScreenshot } from './screenshot.js';
import { waitForStablePage } from './stability.js';
import type {
  ScreenshotResult,
  SessionEvents,
  StabilityOptions,
  StabilityReport,
  TabInfo,
} from './types.js';
import { attachPageWatchdogs, SessionEventLog, type WatchdogOptions } from './watchdogs.js';

const log = createLogger('browser:session');

export interface LaunchOptions extends WatchdogOptions {
  /** Persistent profile directory for authenticated sessions. */
  profileDir?: string;
}

/**
 * Owns one BrowserContext: tab registry, popup adoption, watchdogs,
 * stability gating, screenshots, crash restore, and the CDP escape hatch.
 *
 * This class is the only place that touches Playwright session lifecycle —
 * keeping the dependency isolated so a CDP-native driver can replace it
 * without touching the agent.
 */
export class BrowserSession {
  readonly events = new SessionEventLog();
  private pages: Page[] = [];
  private activeIndex = 0;
  private lastUrl = 'about:blank';

  private constructor(
    private readonly config: BrowserConfig,
    private readonly context: BrowserContext,
    private readonly browser: Browser | undefined,
    private readonly options: LaunchOptions | undefined,
  ) {}

  static async launch(config: BrowserConfig, options?: LaunchOptions): Promise<BrowserSession> {
    let browser: Browser | undefined;
    let context: BrowserContext;
    const contextOptions = {
      viewport: { width: config.viewportWidth, height: config.viewportHeight },
      acceptDownloads: true,
    };
    if (options?.profileDir) {
      context = await chromium.launchPersistentContext(options.profileDir, {
        headless: config.headless,
        ...contextOptions,
      });
    } else {
      browser = await chromium.launch({ headless: config.headless });
      context = await browser.newContext(contextOptions);
    }
    context.setDefaultNavigationTimeout(config.navigationTimeoutMs);
    context.setDefaultTimeout(config.navigationTimeoutMs);

    const session = new BrowserSession(config, context, browser, options);

    // Popup adoption: new tabs/popups (window.open, target=_blank) are
    // registered and become the active tab, mirroring user-visible focus.
    context.on('page', (page) => {
      if (session.pages.includes(page)) return;
      session.adoptPage(page);
      session.activeIndex = session.pages.length - 1;
      session.events.recordPopupAdopted();
      log.debug({ url: page.url() }, 'adopted popup page');
    });

    const initial = context.pages()[0] ?? (await context.newPage());
    if (!session.pages.includes(initial)) {
      session.adoptPage(initial);
    }
    return session;
  }

  private adoptPage(page: Page): void {
    this.pages.push(page);
    attachPageWatchdogs(page, this.events, this.options);
    page.on('close', () => {
      const index = this.pages.indexOf(page);
      if (index !== -1) {
        this.pages.splice(index, 1);
        if (this.activeIndex >= this.pages.length) {
          this.activeIndex = Math.max(0, this.pages.length - 1);
        }
      }
    });
  }

  get page(): Page {
    const page = this.pages[this.activeIndex];
    if (!page) {
      throw new BrowserError('No open pages in session');
    }
    return page;
  }

  currentUrl(): string {
    return this.page.url();
  }

  async navigate(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    this.lastUrl = url;
  }

  async waitForStable(options?: StabilityOptions): Promise<StabilityReport> {
    return waitForStablePage(this.page, options);
  }

  async screenshot(): Promise<ScreenshotResult> {
    return takeScreenshot(this.page);
  }

  tabs(): TabInfo[] {
    return this.pages.map((page, index) => ({
      index,
      url: page.url(),
      // page.title() is async; URL is enough for tab listings and the
      // observation layer fetches titles when it needs them.
      title: '',
      active: index === this.activeIndex,
    }));
  }

  async switchTab(index: number): Promise<void> {
    if (index < 0 || index >= this.pages.length) {
      throw new BrowserError(`No tab at index ${index}`, {
        context: { index, tabCount: this.pages.length },
      });
    }
    this.activeIndex = index;
    await this.page.bringToFront();
  }

  async newTab(): Promise<void> {
    const page = await this.context.newPage();
    if (!this.pages.includes(page)) {
      this.adoptPage(page);
    }
    this.activeIndex = this.pages.indexOf(page);
  }

  /**
   * CDP escape hatch (chromium only). Perception uses this for the full
   * accessibility tree; recovery uses it for crash diagnostics.
   */
  async cdpSession(): Promise<CDPSession> {
    return this.context.newCDPSession(this.page);
  }

  drainEvents(): SessionEvents {
    return this.events.drain();
  }

  /** After a crash: replace the dead page and re-navigate to the last URL. */
  async restore(): Promise<void> {
    const dead = this.pages[this.activeIndex];
    if (dead) {
      this.pages.splice(this.activeIndex, 1);
      await dead.close().catch(() => undefined);
    }
    const page = await this.context.newPage();
    if (!this.pages.includes(page)) {
      this.adoptPage(page);
    }
    this.activeIndex = this.pages.indexOf(page);
    if (this.lastUrl && this.lastUrl !== 'about:blank') {
      await this.navigate(this.lastUrl);
    }
    log.info({ url: this.lastUrl }, 'session restored after crash');
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
  }
}
