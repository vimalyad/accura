import type { Logger } from '@accura/shared';
import type { BrowserSession } from '@accura/browser';
import type { Observer } from '@accura/perception';
import type { ChatModel } from '@accura/llm';

export interface ActionContext {
  session: BrowserSession;
  observer: Observer;
  /** Model used by the extract action; omit to disable extraction. */
  extractor?: ChatModel;
  /** Agent scratchpad (todo.md, results.md). In-memory; persisted via traces. */
  scratchpad: Map<string, string>;
  log: Logger;
}
