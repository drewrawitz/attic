/**
 * A prompt as the server registers it: a fixed text that a client asks for by name, to follow.
 * It takes nothing. Many clients do not show prompts, so a tool returns the same text
 * (ADR 0007).
 */
export interface Prompt {
  readonly name: string;
  /** What it is for, in one line. A client shows it beside the name. */
  readonly description: string;
  readonly text: string;
}
