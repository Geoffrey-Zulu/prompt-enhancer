import { MAX_ROUGH_TEXT_CHARS, type RenderedPrompt } from '@prompt-enhancer/prompts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelError, type ModelClient, type ModelInfo } from '../providers/types.js';
import type { Services } from '../services/index.js';

/**
 * `resolveSession` is mocked rather than injected: its own behaviour is covered
 * by the §7 rules elsewhere, and what these tests are about is what the handler
 * does with a session once it has one.
 */
const resolveSession = vi.hoisted(() => vi.fn());
vi.mock('../enhance/session.js', () => ({ resolveSession }));

const { createChatHandler, createFollowupProvider, modeFrom, PARTICIPANT_ID } = await import(
  './participant.js'
);

const SERVICES = {} as Services;

interface Recorded {
  markdown: string[];
  buttons: Array<{ command: string; title: string; arguments?: unknown[] }>;
  progress: string[];
}

function fakeStream(): { stream: import('vscode').ChatResponseStream; recorded: Recorded } {
  const recorded: Recorded = { markdown: [], buttons: [], progress: [] };
  const stream = {
    markdown: (value: string) => recorded.markdown.push(String(value)),
    button: (command: { command: string; title: string; arguments?: unknown[] }) =>
      recorded.buttons.push(command),
    progress: (value: string) => recorded.progress.push(value),
    anchor: () => undefined,
    filetree: () => undefined,
    reference: () => undefined,
    push: () => undefined,
  } as unknown as import('vscode').ChatResponseStream;
  return { stream, recorded };
}

function fakeToken(cancelled = false): import('vscode').CancellationToken {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: () => ({ dispose: () => undefined }),
  } as unknown as import('vscode').CancellationToken;
}

function fakeRequest(prompt: string, command?: string): import('vscode').ChatRequest {
  return { prompt, command } as unknown as import('vscode').ChatRequest;
}

function fakeContext(
  history: Array<{ prompt: string; command?: string }> = [],
): import('vscode').ChatContext {
  return { history } as unknown as import('vscode').ChatContext;
}

/** A client whose stream is whatever the test says it is. */
function fakeClient(
  behaviour: { deltas?: string[]; throwAfter?: unknown } = {},
): { client: ModelClient; calls: Array<{ prompt: RenderedPrompt; model: string }> } {
  const calls: Array<{ prompt: RenderedPrompt; model: string }> = [];
  const client: ModelClient = {
    provider: 'anthropic',
    listModels: (): Promise<ModelInfo[]> => Promise.resolve([]),
    enhance: (): Promise<string> => Promise.reject(new Error('the chat path streams (D8)')),
    enhanceStream: async function* (prompt, model): AsyncIterable<string> {
      calls.push({ prompt, model });
      for (const delta of behaviour.deltas ?? []) {
        yield delta;
      }
      if (behaviour.throwAfter !== undefined) {
        throw behaviour.throwAfter;
      }
    },
  };
  return { client, calls };
}

function session(client: ModelClient): unknown {
  return { client, provider: 'anthropic', model: 'a-model-id' };
}

beforeEach(() => {
  resolveSession.mockReset();
});

describe('modeFrom', () => {
  it('takes the mode from the slash command and defaults to code', () => {
    expect(modeFrom('architecture')).toBe('architecture');
    expect(modeFrom('refactor')).toBe('refactor');
    expect(modeFrom('code')).toBe('code');
    expect(modeFrom(undefined)).toBe('code');
    // §5's enum is closed: an unknown command is not a mode.
    expect(modeFrom('wishful')).toBe('code');
  });
});

describe('the chat handler', () => {
  it('matches the participant id in package.json exactly', () => {
    // §8 Flow B.2: `createChatParticipant` and the contribution must agree, and
    // a mismatch is a participant that silently never fires.
    expect(PARTICIPANT_ID).toBe('prompt-enhancer.enhance');
  });

  it('asks for input instead of calling out on an empty prompt', async () => {
    const { stream, recorded } = fakeStream();

    await createChatHandler(SERVICES)(fakeRequest('   '), fakeContext(), stream, fakeToken());

    expect(resolveSession).not.toHaveBeenCalled();
    expect(recorded.markdown.join('')).toMatch(/rough note/i);
  });

  it('enforces the input cap before resolving a session', async () => {
    const { stream, recorded } = fakeStream();

    await createChatHandler(SERVICES)(
      fakeRequest('x'.repeat(MAX_ROUGH_TEXT_CHARS + 1)),
      fakeContext(),
      stream,
      fakeToken(),
    );

    // §6: the cap is what stops a giant paste becoming a surprise bill, so it
    // has to bite before the request, not after.
    expect(resolveSession).not.toHaveBeenCalled();
    expect(recorded.markdown.join('')).toMatch(/over the/i);
  });

  it('stops quietly when there is no key — the reporter has already spoken', async () => {
    resolveSession.mockResolvedValue(undefined);
    const { stream, recorded } = fakeStream();

    await createChatHandler(SERVICES)(fakeRequest('a note'), fakeContext(), stream, fakeToken());

    expect(recorded.buttons).toHaveLength(0);
    expect(recorded.progress).toHaveLength(0);
  });

  it('streams deltas as they arrive and names the model that answered', async () => {
    const { client, calls } = fakeClient({ deltas: ['# Role\n', 'You are…'] });
    resolveSession.mockResolvedValue(session(client));
    const { stream, recorded } = fakeStream();

    await createChatHandler(SERVICES)(
      fakeRequest('make login validate email', 'refactor'),
      fakeContext(),
      stream,
      fakeToken(),
    );

    // D8: rendered as they arrive, not assembled and pushed once.
    expect(recorded.markdown).toEqual(['# Role\n', 'You are…']);
    // §8 Flow B.4: the user always knows which model answered.
    expect(recorded.progress.join('')).toContain('a-model-id');
    expect(recorded.progress.join('')).toContain('Anthropic');
    // The slash command chose the mode, and it reached the prompt.
    expect(calls[0]?.prompt.system).toContain('**refactor**');
    expect(calls[0]?.model).toBe('a-model-id');
  });

  it('offers Insert and Copy once the stream finished cleanly', async () => {
    resolveSession.mockResolvedValue(session(fakeClient({ deltas: ['the prompt'] }).client));
    const { stream, recorded } = fakeStream();

    await createChatHandler(SERVICES)(fakeRequest('a note'), fakeContext(), stream, fakeToken());

    expect(recorded.buttons.map((button) => button.title)).toEqual([
      'Insert into editor',
      'Copy',
    ]);
    // The buttons carry the text, so the commands need no shared state.
    expect(recorded.buttons[0]?.arguments).toEqual(['the prompt']);
    expect(recorded.buttons[0]?.command).toBe('promptEnhancer.insertResult');
  });

  it('offers nothing when the terminal finish reason says the result is not finished', async () => {
    // The adapters check the finish reason at the *end* of the stream, so the
    // partial text is already on screen. It must not be presented as complete.
    const failure = new ModelError('truncated', { provider: 'anthropic', model: 'a-model-id' });
    resolveSession.mockResolvedValue(
      session(fakeClient({ deltas: ['half an ans'], throwAfter: failure }).client),
    );
    const { stream, recorded } = fakeStream();

    await createChatHandler(SERVICES)(fakeRequest('a note'), fakeContext(), stream, fakeToken());

    expect(recorded.markdown.join('')).toContain('half an ans');
    expect(recorded.markdown.join('')).toMatch(/truncated/i);
    expect(recorded.buttons).toHaveLength(0);
  });

  it('reports a rejected key in the stream, with the action as a button', async () => {
    // §8 Flow B.4: reported where the user is looking, not as a toast behind the
    // panel — and through the same §9.4 table Flow A uses.
    resolveSession.mockResolvedValue(
      session(fakeClient({ throwAfter: new ModelError('auth', { provider: 'anthropic' }) }).client),
    );
    const { stream, recorded } = fakeStream();

    await createChatHandler(SERVICES)(fakeRequest('a note'), fakeContext(), stream, fakeToken());

    expect(recorded.markdown.join('')).toMatch(/Anthropic API key was rejected/i);
    expect(recorded.buttons.map((button) => button.title)).toEqual(['Set API Key']);
  });

  it('stops mid-stream on cancellation and offers no buttons', async () => {
    const { client } = fakeClient({ deltas: ['one', 'two', 'three'] });
    resolveSession.mockResolvedValue(session(client));
    const { stream, recorded } = fakeStream();

    await createChatHandler(SERVICES)(
      fakeRequest('a note'),
      fakeContext(),
      stream,
      fakeToken(true),
    );

    // Already-cancelled: the loop breaks on the first delta rather than
    // rendering the rest, and nothing is offered for a result that is not one.
    expect(recorded.markdown).toHaveLength(0);
    expect(recorded.buttons).toHaveLength(0);
  });

  it('says so rather than offering buttons when the stream was empty', async () => {
    resolveSession.mockResolvedValue(session(fakeClient({ deltas: [] }).client));
    const { stream, recorded } = fakeStream();

    await createChatHandler(SERVICES)(fakeRequest('a note'), fakeContext(), stream, fakeToken());

    expect(recorded.buttons).toHaveLength(0);
    expect(recorded.markdown.join('')).toMatch(/nothing usable/i);
  });
});

describe('followups', () => {
  it('offers the same note in the two modes that were not used', () => {
    const followups = createFollowupProvider().provideFollowups(
      {},
      fakeContext([{ prompt: 'make login validate email', command: 'refactor' }]),
      fakeToken(),
    );

    expect(followups).toEqual([
      { prompt: 'make login validate email', command: 'code', label: 'Try /code' },
      {
        prompt: 'make login validate email',
        command: 'architecture',
        label: 'Try /architecture',
      },
    ]);
  });

  it('offers nothing when there is no previous prompt to re-run', () => {
    expect(
      createFollowupProvider().provideFollowups({}, fakeContext([]), fakeToken()),
    ).toEqual([]);
  });
});
