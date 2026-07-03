import { createConnection, type Socket } from "node:net";

type DapRequest = {
  seq: number;
  type: "request";
  command: string;
  arguments?: unknown;
};

type DapResponse<T = unknown> = {
  seq: number;
  type: "response";
  request_seq: number;
  success: boolean;
  command: string;
  message?: string;
  body?: T;
};

export type DapEvent<T = unknown> = {
  seq: number;
  type: "event";
  event: string;
  body?: T;
};

type DapServerRequest = {
  seq: number;
  type: "request";
  command: string;
  arguments?: unknown;
};

type PendingRequest = {
  resolve: (response: DapResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type EventWaiter = {
  predicate: (event: DapEvent) => boolean;
  resolve: (event: DapEvent) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class DapProtocolError extends Error {
  constructor(
    message: string,
    readonly response?: DapResponse,
  ) {
    super(message);
    this.name = "DapProtocolError";
  }
}

export class DapClient {
  private seq = 1;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<number, PendingRequest>();
  private readonly events: DapEvent[] = [];
  private waiters: EventWaiter[] = [];
  private closed = false;

  constructor(private readonly socket: Socket) {
    socket.on("data", (chunk) => {
      try {
        this.receive(chunk);
      } catch (error) {
        this.failAll(error instanceof Error ? error : new Error(String(error)));
        this.socket.destroy();
      }
    });
    socket.on("error", (error) => this.failAll(error));
    socket.on("close", () => this.failAll(new Error("DAP socket closed")));
  }

  request<T = unknown>(command: string, args: unknown = {}, timeoutMs = 30_000): Promise<DapResponse<T>> {
    if (this.closed) return Promise.reject(new Error("DAP socket is closed"));

    const seq = this.seq++;
    const request: DapRequest = { seq, type: "request", command, arguments: args };
    this.send(request);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`Timed out waiting for DAP response to ${command}`));
      }, timeoutMs);

      this.pending.set(seq, {
        resolve: (response) => resolve(response as DapResponse<T>),
        reject,
        timer,
      });
    });
  }

  waitForEvent<T = unknown>(predicate: (event: DapEvent) => boolean, timeoutMs = 30_000): Promise<DapEvent<T>> {
    const existingIndex = this.events.findIndex(predicate);
    if (existingIndex >= 0) {
      const [existing] = this.events.splice(existingIndex, 1);
      return Promise.resolve(existing as DapEvent<T>);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== record);
        reject(new Error("Timed out waiting for DAP event"));
      }, timeoutMs);

      const record: EventWaiter = {
        predicate,
        resolve: (event) => resolve(event as DapEvent<T>),
        reject,
        timer,
      };
      this.waiters.push(record);
    });
  }

  dispose() {
    this.closed = true;
    this.socket.destroy();
    this.failAll(new Error("DAP client disposed"));
  }

  private receive(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;

      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const lengthMatch = /^Content-Length:\s*(\d+)$/im.exec(header);
      if (!lengthMatch) throw new Error(`Invalid DAP header: ${header}`);

      const contentLength = Number(lengthMatch[1]);
      const messageEnd = headerEnd + 4 + contentLength;
      if (this.buffer.length < messageEnd) return;

      const payload = this.buffer.subarray(headerEnd + 4, messageEnd).toString("utf8");
      this.buffer = this.buffer.subarray(messageEnd);
      this.handleMessage(JSON.parse(payload));
    }
  }

  private handleMessage(message: DapResponse | DapEvent | DapServerRequest) {
    if (message.type === "response") {
      const pending = this.pending.get(message.request_seq);
      if (!pending) return;

      clearTimeout(pending.timer);
      this.pending.delete(message.request_seq);

      if (message.success) pending.resolve(message);
      else pending.reject(new DapProtocolError(message.message ?? `DAP ${message.command} failed`, message));
      return;
    }

    if (message.type === "event") {
      let delivered = false;
      for (const waiter of [...this.waiters]) {
        if (!waiter.predicate(message)) continue;
        clearTimeout(waiter.timer);
        this.waiters = this.waiters.filter((item) => item !== waiter);
        waiter.resolve(message);
        delivered = true;
        break;
      }
      if (!delivered) this.events.push(message);
      return;
    }

    if (message.type === "request") {
      // debugpy may ask optional client-side questions. The MVP does not support
      // any, so acknowledge them to keep the adapter moving.
      this.send({
        seq: this.seq++,
        type: "response",
        request_seq: message.seq,
        command: message.command,
        success: true,
      });
    }
  }

  private send(message: Record<string, unknown>) {
    const body = JSON.stringify(message);
    this.socket.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  private failAll(error: Error) {
    if (this.closed && error.message !== "DAP client disposed") return;
    this.closed = true;

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();

    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters = [];
  }
}

export async function connectDap(host: string, port: number, timeoutMs: number, signal?: AbortSignal): Promise<DapClient> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Debug connection aborted");

    try {
      const socket = await connectSocket(host, port, Math.min(1_000, deadline - Date.now()));
      return new DapClient(socket);
    } catch (error) {
      lastError = error;
      await delay(75, signal);
    }
  }

  throw new Error(
    `Timed out connecting to debugpy at ${host}:${port}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

function connectSocket(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("connect timeout"));
    }, timeoutMs);

    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    });
  });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      },
      { once: true },
    );
  });
}
