// 0.1.7 V4 message sources are producer-owned: each producer declares its own
// `kind` via MessageSourceMap module merging ("there is no shared catch-all
// `plugin` kind" — dsh-llm message.d.ts). The retired generic kind:'plugin'
// wrapper is refused on write by the session format ("format v4 message
// requires a producer-owned source kind"), so the heartbeat names itself.
import '@deepseek-ai/dsh-llm';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Heartbeat plugin injections: engine-room turns, delivery, time injection. */
    heartbeat: {
      kind: 'heartbeat';
      plugin?: string;
      form?: string;
      sections?: { name: string; text: string }[];
    };
  }
}
