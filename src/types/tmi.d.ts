declare module 'tmi.js' {
  export interface ChatUserstate {
    'display-name'?: string;
    username?: string;
    [key: string]: unknown;
  }

  export interface ClientOptions {
    options?: { debug?: boolean };
    identity?: { username: string; password: string };
    channels?: string[];
  }

  export class Client {
    constructor(opts?: ClientOptions);
    connect(): Promise<[string, number]>;
    disconnect(): Promise<[string, number]>;
    on(
      event: 'message' | 'chat',
      listener: (channel: string, tags: ChatUserstate, message: string, self: boolean) => void
    ): this;
  }

  const tmi: {
    Client: typeof Client;
  };
  export default tmi;
}
