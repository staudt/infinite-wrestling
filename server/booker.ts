import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { fallbackEpisode } from '../src/booker/fallback';
import { buildGenesisPrompt, buildUserPrompt, GENESIS_PROMPT, SYSTEM_PROMPT } from '../src/booker/prompt';
import { reviewEpisode } from '../src/booker/validate';
import { type Episode, EpisodeDraft } from '../src/schema/episode';
import { Promotion } from '../src/schema/promotion';
import { offlineWorld, reviewPromotion } from '../src/world/genesis';
import type { World } from '../src/world/state';
import { latestPromotion, loadEpisode, saveEpisode, saveFailure, savePromotion } from './sessions';

// Read lazily: callers may load .env after importing this module.
export const model = () => process.env.BOOKER_MODEL || 'claude-haiku-4-5';

export type Source = 'llm' | 'cache' | 'offline';

export interface Booked {
  episode: Episode;
  source: Source;
  problems: string[];
}

export interface Created {
  world: World;
  source: Source;
  problems: string[];
}

export function llmAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  client ??= new Anthropic({ timeout: 180_000 });
  return client;
}

// These models reject forced tool_choice; there we ask for the tool in the prompt instead.
const NO_FORCED_TOOLS = /fable-5-1|mythos-5-1|opus-5-5/;

interface ToolSpec {
  name: string;
  description: string;
  schema: z.ZodType;
  system: string;
}

/** A plain (non-strict) tool: the schema is guidance, and Zod + our reviewers validate. */
function toolFor(spec: ToolSpec): Anthropic.Tool {
  // io: 'input' marks defaulted fields optional, matching what the lenient parser accepts.
  const { $schema: _drop, ...schema } = z.toJSONSchema(spec.schema, { io: 'input' }) as Record<string, unknown>;
  return { name: spec.name, description: spec.description, input_schema: schema as Anthropic.Tool.InputSchema };
}

async function callTool(spec: ToolSpec, messages: Anthropic.MessageParam[]) {
  const m = model();
  const res = await getClient().messages.create({
    model: m,
    max_tokens: 16000,
    // Tools render before the system prompt, so this breakpoint caches schema + instructions.
    system: [{ type: 'text', text: spec.system, cache_control: { type: 'ephemeral' } }],
    tools: [toolFor(spec)],
    tool_choice: NO_FORCED_TOOLS.test(m) ? { type: 'auto' } : { type: 'tool', name: spec.name },
    messages,
  });
  const u = res.usage;
  console.error(`[booker] ${m} ${spec.name}: in=${u.input_tokens} cache_write=${u.cache_creation_input_tokens ?? 0} ` +
    `cache_read=${u.cache_read_input_tokens ?? 0} out=${u.output_tokens} stop=${res.stop_reason}`);
  if (res.stop_reason === 'max_tokens') throw new Error('output was cut off (max_tokens)');
  if (res.stop_reason === 'refusal') throw new Error('model refused');
  const block = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === spec.name);
  return { input: block?.input ?? null, content: res.content, toolUseId: block?.id ?? null };
}

/**
 * Call and review. Problems the reviewer could repair are accepted as-is (logged for
 * prompt tuning); only an unplayable result pays for one retry, with the problems sent
 * back as a tool error.
 */
async function callWithRetry<T>(
  spec: ToolSpec,
  prompt: string,
  review: (input: unknown) => { value: T | null; problems: string[] },
): Promise<{ value: T | null; problems: string[] }> {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: prompt }];
  const first = await callTool(spec, messages);
  let result = review(first.input);
  if (!first.input) result = { value: null, problems: [`you must call the ${spec.name} tool`] };
  if (result.problems.length) saveFailure(spec.name, first.input, result.problems);
  if (result.value) {
    if (result.problems.length) console.error(`[booker] repaired ${result.problems.length} problem(s) in ${spec.name}, no retry needed`);
    return result;
  }

  console.error(`[booker] retrying ${spec.name}; problems: ${result.problems.join(' | ')}`);
  messages.push({ role: 'assistant', content: first.content });
  const fix = `That has problems:\n${result.problems.map((p) => `- ${p}`).join('\n')}\nCall ${spec.name} again with the corrected, complete result.`;
  messages.push({
    role: 'user',
    content: first.toolUseId ? [{ type: 'tool_result', tool_use_id: first.toolUseId, is_error: true, content: fix }] : fix,
  });
  const retry = await callTool(spec, messages);
  const second = review(retry.input);
  if (second.problems.length) saveFailure(`${spec.name}-retry`, retry.input, second.problems);
  // Keep whichever attempt is playable, preferring the retry.
  return second.value || !result.value ? second : result;
}

function logError(what: string, err: unknown): void {
  if (err instanceof Anthropic.APIConnectionError) console.error(`[booker] ${what}: can't reach the API (${err.message}) — network down or machine asleep?`);
  else if (err instanceof Anthropic.AuthenticationError) console.error(`[booker] ${what}: authentication failed — check ANTHROPIC_API_KEY`);
  else if (err instanceof Anthropic.RateLimitError) console.error(`[booker] ${what}: rate limited`);
  else if (err instanceof Anthropic.APIError) console.error(`[booker] ${what}: API error ${err.status}: ${err.message}`);
  else console.error(`[booker] ${what}: ${(err as Error).message}`);
}

const EPISODE_TOOL: ToolSpec = {
  name: 'book_episode',
  description: 'Submit the complete booked episode as one ordered list of beats, with a "segment" marker beat starting each segment.',
  schema: EpisodeDraft,
  system: SYSTEM_PROMPT,
};

const PROMOTION_TOOL: ToolSpec = {
  name: 'create_promotion',
  description: 'Submit the complete new promotion.',
  schema: Promotion,
  system: GENESIS_PROMPT,
};

/**
 * Book the next episode: reuse a stored one for this world and episode number, else ask
 * the LLM (and store the result), else fall back to the offline booker.
 */
export async function bookEpisode(world: World): Promise<Booked> {
  const number = world.episode + 1;
  const stored = loadEpisode(world.seed, number);
  if (stored) {
    const rv = reviewEpisode(stored, world);
    if (rv.episode) return { episode: rv.episode, source: 'cache', problems: [] };
  }
  if (llmAvailable()) {
    try {
      const r = await callWithRetry(EPISODE_TOOL, buildUserPrompt(world), (input) => {
        const rv = reviewEpisode(input, world);
        return { value: rv.episode, problems: rv.problems };
      });
      if (r.value) {
        saveEpisode(world.seed, number, r.value);
        return { episode: r.value, source: 'llm', problems: r.problems };
      }
      console.error(`[booker] unusable episode, using offline booker: ${r.problems.join(' | ')}`);
    } catch (err) {
      logError('book_episode', err);
    }
  }
  return { episode: fallbackEpisode(world), source: 'offline', problems: [] };
}

/**
 * Create a brand-new promotion (roster, titles, feuds) with the LLM, or offline.
 * With `cached`, reuse the most recently created promotion instead (and its stored
 * episodes replay for free).
 */
export async function createPromotion(direction: string, seed: number, cached = false): Promise<Created> {
  if (cached) {
    const latest = latestPromotion();
    if (latest) {
      console.error(`[booker] --cached: reusing "${latest.world.showName}" (${latest.episodes} stored episodes)`);
      return { world: latest.world, source: 'cache', problems: [] };
    }
    console.error('[booker] --cached: no stored promotion yet, creating one');
  }
  if (llmAvailable()) {
    try {
      const r = await callWithRetry(PROMOTION_TOOL, buildGenesisPrompt(direction, seed), (input) => {
        const rv = reviewPromotion(input, direction, seed);
        return { value: rv.world, problems: rv.problems };
      });
      if (r.value) {
        savePromotion(r.value);
        return { world: r.value, source: 'llm', problems: r.problems };
      }
      console.error(`[booker] unusable promotion, generating offline: ${r.problems.join(' | ')}`);
    } catch (err) {
      logError('create_promotion', err);
    }
  }
  return { world: offlineWorld(seed, direction), source: 'offline', problems: [] };
}
