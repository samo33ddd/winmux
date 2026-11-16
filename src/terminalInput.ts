export const TERMINAL_INPUT_CHUNK_BYTES = 8 * 1024;

function splitTerminalInput(data: string): string[] {
  const chunks: string[] = [];
  let chunk = '';
  let bytes = 0;
  for (const character of data) {
    const codePoint = character.codePointAt(0)!;
    const size = codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
    if (bytes && bytes + size > TERMINAL_INPUT_CHUNK_BYTES) {
      chunks.push(chunk);
      chunk = '';
      bytes = 0;
    }
    chunk += character;
    bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export class TerminalInputQueue {
  private pending: string[] = [];
  private active: Promise<void> | null = null;
  private stopped = false;
  private readonly send: (data: string) => Promise<unknown>;
  private readonly onError: (error: unknown) => void;

  constructor(send: (data: string) => Promise<unknown>, onError: (error: unknown) => void) {
    this.send = send;
    this.onError = onError;
  }

  enqueue(data: string) {
    if (this.stopped || !data) return;
    this.pending.push(...splitTerminalInput(data));
    if (!this.active) this.startDrain();
  }

  close() {
    this.stopped = true;
    this.pending.length = 0;
  }

  private startDrain() {
    const run = this.drain();
    this.active = run;
    void run.then(() => {
      if (this.active !== run) return;
      this.active = null;
      if (!this.stopped && this.pending.length) this.startDrain();
    });
  }

  private async drain() {
    try {
      while (!this.stopped && this.pending.length) {
        await this.send(this.pending.shift()!);
      }
    } catch (error) {
      if (!this.stopped) {
        this.pending.length = 0;
        this.onError(error);
      }
    }
  }
}
