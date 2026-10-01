import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import {
  buildGenesisPrompt, buildPlanPrompt, buildTransitionPrompt, buildUserPrompt, GENESIS_PROMPT, PLAN_PROMPT, SYSTEM_PROMPT, TRANSITION_PROMPT,
} from '../src/booker/prompt';
import { unstringify } from '../src/booker/json';
import { resolveIds } from '../src/booker/validate';
import { type SeasonPlan, SeasonPlan as SeasonPlanSchema, type SeasonStart, type SeasonTransition, SeasonTransition as SeasonTransitionSchema } from '../src/schema/season';
import { applySeasonStart, applyTransition, isSeasonStart, offlinePlan, PPV_EPISODES, seasonOf } from '../src/world/season';
import { reviewEpisode } from '../src/booker/validate';
import { type Episode, EpisodeDraft } from '../src/schema/episode';
import { Promotion } from '../src/schema/promotion';
import { reviewPromotion } from '../src/world/genesis';
import type { World } from '../src/world/state';
import { loadEpisode, saveEpisode, saveFailure, savePromotion } from './sessions';

// Read lazily: callers may load .env after importing this module.
export const model = () => process.env.BOOKER_MODEL || 'claude-haiku-4-5';
/** The long-term calls (season plan, off-season) are few and benefit from a stronger model. */
export const planModel = () => process.env.BOOKER_PLAN_MODEL || 'claude-sonnet-5';

export type Source = 'llm' | 'cache';

/** Why nothing could be produced: no LLM configured, or the LLM failed. */
export interface Unavailable { reason: 'no-llm' | 'error'; message: string }

export type Booked = { episode: Episode; source: Source; problems: string[] } | ({ episode: null } & Unavailable);

export type Created = { world: World; source: Source; problems: string[] } | ({ world: null } & Unavailable);

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
  /** Model override (defaults to BOOKER_MODEL). */
  model?: () => string;
}

/** A plain (non-strict) tool: the schema is guidance, and Zod + our reviewers validate. */
function toolFor(spec: ToolSpec): Anthropic.Tool {
  // io: 'input' marks defaulted fields optional, matching what the lenient parser accepts.
  const { $schema: _drop, ...schema } = z.toJSONSchema(spec.schema, { io: 'input' }) as Record<string, unknown>;
  return { name: spec.name, description: spec.description, input_schema: schema as Anthropic.Tool.InputSchema };
}

async function callTool(spec: ToolSpec, messages: Anthropic.MessageParam[]) {
  const m = (spec.model ?? model)();
  const haiku = /haiku/.test(m);
  // Streaming, so thinking models (Sonnet/Opus plan the season) get a big output budget
  // without HTTP timeouts; medium effort keeps their thinking from eating it all.
  const res = await getClient().messages.stream({
    model: m,
    max_tokens: haiku ? 16000 : 48000,
    ...(haiku ? {} : { output_config: { effort: 'medium' as const } }),
    // Tools render before the system prompt, so this breakpoint caches schema + instructions.
    system: [{ type: 'text', text: spec.system, cache_control: { type: 'ephemeral' } }],
    tools: [toolFor(spec)],
    // Forced tool use is only safe on models that don't think by default (Haiku);
    // elsewhere the prompt asks for the tool and a missing call gets a retry.
    tool_choice: haiku && !NO_FORCED_TOOLS.test(m) ? { type: 'tool', name: spec.name } : { type: 'auto' },
    messages,
  }).finalMessage();
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

/** A short, viewer-safe description of an API failure. */
function errorText(err: unknown): string {
  if (err instanceof Anthropic.APIConnectionError) return "can't reach the API";
  if (err instanceof Anthropic.AuthenticationError) return 'API key rejected';
  if (err instanceof Anthropic.RateLimitError) return 'rate limited';
  if (err instanceof Anthropic.APIError) return `API error ${err.status ?? ''}`.trim();
  return (err as Error).message;
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

const PLAN_TOOL: ToolSpec = {
  name: 'plan_season',
  description: 'Submit the season plan: theme, the three PPVs, and the long-term arcs.',
  schema: SeasonPlanSchema,
  system: PLAN_PROMPT,
  model: planModel,
};

const TRANSITION_TOOL: ToolSpec = {
  name: 'season_transition',
  description: 'Submit the off-season: season recap, departures and arrivals.',
  schema: SeasonTransitionSchema,
  system: TRANSITION_PROMPT,
  model: planModel,
};

/** Keep only known ids in a plan, and make sure all three PPVs exist. */
function reviewPlan(input: unknown, world: World, season: number): { value: SeasonPlan | null; problems: string[] } {
  const parsed = SeasonPlanSchema.safeParse(resolveIds(unstringify(input), world));
  if (!parsed.success) return { value: null, problems: parsed.error.issues.slice(0, 8).map((i) => `${i.path.join('.')}: ${i.message}`) };
  const plan = parsed.data;
  const ids = new Set(world.characters.map((c) => c.id));
  for (const a of plan.arcs) a.characters = a.characters.filter((id) => ids.has(id));
  const fallback = offlinePlan(season);
  plan.ppvs = PPV_EPISODES.map((e) => plan.ppvs.find((p) => p.episode === e) ?? fallback.ppvs.find((p) => p.episode === e)!);
  return plan.arcs.length ? { value: plan, problems: [] } : { value: null, problems: ['the plan needs 3-5 arcs'] };
}

function reviewTransition(input: unknown, world: World): { value: SeasonTransition | null; problems: string[] } {
  const parsed = SeasonTransitionSchema.safeParse(resolveIds(unstringify(input), world));
  if (!parsed.success) return { value: null, problems: parsed.error.issues.slice(0, 8).map((i) => `${i.path.join('.')}: ${i.message}`) };
  const t = parsed.data;
  t.departures = t.departures.filter((d) => world.characters.some((c) => c.id === d.id && c.role !== 'interviewer'));
  return { value: t, problems: [] };
}

/** Off-season shuffle + season plan, with the LLM when available (offline otherwise). */
async function seasonStartFor(world: World, season: number): Promise<SeasonStart> {
  let transition: SeasonTransition | null = null;
  if (season > 1) {
    if (llmAvailable()) {
      try {
        transition = (await callWithRetry(TRANSITION_TOOL, buildTransitionPrompt(world, season - 1), (i) => reviewTransition(i, world))).value;
      } catch (err) {
        logError('season_transition', err);
      }
    }
    // If the off-season call fails the roster simply carries over.
    console.error(`[booker] season ${season}: ${transition ? `${transition.departures.length} leave, ${transition.arrivals.length} arrive` : 'roster carries over'}`);
  }
  const shuffled = applyTransition(world, transition, season);
  let plan: SeasonPlan | null = null;
  if (llmAvailable()) {
    try {
      plan = (await callWithRetry(PLAN_TOOL, buildPlanPrompt(shuffled, season), (i) => reviewPlan(i, shuffled, season))).value;
    } catch (err) {
      logError('plan_season', err);
    }
  }
  plan ??= offlinePlan(season);
  console.error(`[booker] season ${season} plan: ${plan.ppvs.map((p) => p.name).join(' / ')}; ${plan.arcs.length} arcs`);
  return { season, transition, plan };
}

/**
 * Book the next episode: reuse a stored one for this world and episode number, else ask
 * the LLM (and store the result), else report why it's unavailable. A season's first
 * episode also carries the off-season shuffle and the season plan.
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
      const seasonStart = isSeasonStart(number) ? await seasonStartFor(world, seasonOf(number)) : null;
      const base = seasonStart ? applySeasonStart(world, seasonStart) : world;
      const r = await callWithRetry(EPISODE_TOOL, buildUserPrompt(base), (input) => {
        const rv = reviewEpisode(input, base, { trim: true });
        return { value: rv.episode, problems: rv.problems };
      });
      if (r.value) {
        const episode = seasonStart ? { ...r.value, seasonStart } : r.value;
        saveEpisode(world.seed, number, episode);
        return { episode, source: 'llm', problems: r.problems };
      }
      console.error(`[booker] unusable episode: ${r.problems.join(' | ')}`);
      return { episode: null, reason: 'error', message: 'the booker wrote an unusable episode' };
    } catch (err) {
      logError('book_episode', err);
      return { episode: null, reason: 'error', message: errorText(err) };
    }
  }
  return { episode: null, reason: 'no-llm', message: 'no API key on the booker server' };
}

/** Create a brand-new promotion (roster, titles, feuds) with the LLM, or offline. */
export async function createPromotion(direction: string, seed: number): Promise<Created> {
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
      console.error(`[booker] unusable promotion: ${r.problems.join(' | ')}`);
      return { world: null, reason: 'error', message: 'the booker wrote an unusable promotion' };
    } catch (err) {
      logError('create_promotion', err);
      return { world: null, reason: 'error', message: errorText(err) };
    }
  }
  return { world: null, reason: 'no-llm', message: 'no API key on the booker server' };
}
