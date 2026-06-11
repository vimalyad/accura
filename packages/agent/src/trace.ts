import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * JSONL trajectory writer. Every run is fully replayable: meta line, one
 * line per step (goal, actions, outcomes, diff), result line, plus per-step
 * screenshots as PNG files. This is also the data source for evals and
 * later skill induction.
 */
export class TraceWriter {
  private constructor(
    readonly dir: string,
    private readonly file: string,
  ) {}

  static async create(baseDir: string, runId?: string): Promise<TraceWriter> {
    const id = runId ?? `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const dir = join(baseDir, id);
    await mkdir(join(dir, 'screenshots'), { recursive: true });
    return new TraceWriter(dir, join(dir, 'trace.jsonl'));
  }

  private async append(type: string, data: Record<string, unknown>): Promise<void> {
    await appendFile(this.file, `${JSON.stringify({ type, at: Date.now(), ...data })}\n`, 'utf8');
  }

  async meta(data: Record<string, unknown>): Promise<void> {
    await this.append('meta', data);
  }

  async step(data: Record<string, unknown>): Promise<void> {
    await this.append('step', data);
  }

  async result(data: Record<string, unknown>): Promise<void> {
    await this.append('result', data);
  }

  async screenshot(step: number, dataBase64: string): Promise<void> {
    await writeFile(
      join(this.dir, 'screenshots', `step-${step}.png`),
      Buffer.from(dataBase64, 'base64'),
    );
  }
}
