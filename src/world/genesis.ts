// Creating a brand-new promotion. `reviewPromotion` validates and sanitizes a promotion
// (from the LLM or the offline generator) into a playable World; `randomPromotion` is
// the offline generator, so every new world gets a fresh roster even without an API key.
import { matchCharacter, unstringify } from '../booker/json';
import { hashSeed, Rng } from '../engine/rng';
import type { Division, Style } from '../schema/episode';
import { type NewCharacter, Promotion } from '../schema/promotion';
import { hasMove, MOVES } from '../sim/moves';
import { farthestColor, PALETTE } from '../engine/colors';
import { type Character, CREW_COLORS, crewOf, type World } from './state';

export interface PromotionReview {
  world: World | null;
  problems: string[];
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'x$1') || 'x';

/** Moves that make sense as a finisher for each style. */
const FINISHERS_BY_STYLE: Record<Style, string[]> = {
  brawler: ['piledriver', 'lariat', 'ddt', 'big_splash', 'spear'],
  technician: ['figure_four', 'belly_to_belly', 'suplex', 'boston_crab', 'armbar', 'sleeper'],
  powerhouse: ['powerbomb', 'backbreaker', 'spear', 'powerslam', 'big_boot'],
  highflyer: ['moonsault', 'top_rope_splash', 'top_rope_elbow', 'bulldog', 'crossbody'],
  showman: ['ddt', 'bulldog', 'top_rope_elbow', 'leg_drop', 'neckbreaker'],
};

/** Optional profile fields, only when the model provided something usable. */
export function profileOf(c: { hometown: string; weight: number; catchphrase: string }): Pick<Character, 'hometown' | 'weight' | 'catchphrase'> {
  return {
    ...(c.hometown.trim() ? { hometown: c.hometown.trim() } : {}),
    ...(c.weight >= 80 && c.weight <= 700 ? { weight: Math.round(c.weight) } : {}),
    ...(c.catchphrase.trim() ? { catchphrase: c.catchphrase.trim() } : {}),
  };
}

export function reviewPromotion(raw: unknown, direction: string, seed: number): PromotionReview {
  const parsed = Promotion.safeParse(unstringify(raw));
  if (!parsed.success) {
    return { world: null, problems: parsed.error.issues.slice(0, 12).map((i) => `${i.path.join('.')}: ${i.message}`) };
  }
  const p = parsed.data;
  const problems: string[] = [];
  const rng = new Rng(hashSeed('colors', seed));
  // Rotate the palette per world for variety, then always take the most distinct color left.
  const palette = [...PALETTE.slice(seed % PALETTE.length), ...PALETTE.slice(0, seed % PALETTE.length)];
  const used: string[] = Object.values(CREW_COLORS);
  const ids = new Set<string>();
  const uniqueId = (raw: string) => {
    let id = slug(raw);
    for (let i = 2; ids.has(id); i++) id = `${slug(raw)}_${i}`;
    ids.add(id);
    return id;
  };
  const idMap = new Map<string, string>();

  // Prefer a name-based id ("chet_millwood"): models refer to people by name, not by "interviewer".
  const lanceId = uniqueId(/^(interviewer|announcer|host)$/i.test(p.interviewer.id) || !p.interviewer.id ? p.interviewer.name : p.interviewer.id);
  idMap.set(p.interviewer.id, lanceId);
  const characters: Character[] = [{
    id: lanceId, name: p.interviewer.name, role: 'interviewer', alignment: 'tweener', division: 'men',
    style: 'technician', gimmick: p.interviewer.gimmick, entrance: '', finisher: { name: '', move: 'punch' }, color: '#dddddd',
  }];
  for (const c of p.characters) {
    const id = uniqueId(c.id || c.name);
    if (id !== c.id) problems.push(`character id "${c.id}" was not unique lowercase_snake_case`);
    idMap.set(c.id, id);
    let move = c.finisherMove;
    if (!hasMove(move) || move === 'cover' || move === 'rollup') {
      // Repaired silently: an unknown finisher move isn't worth a paid retry.
      move = rng.pick(FINISHERS_BY_STYLE[c.style]);
    }
    characters.push({
      id, name: c.name.trim(), role: c.role, alignment: c.alignment, division: c.division, style: c.style,
      gimmick: c.gimmick, entrance: c.entrance || 'to a roar from the crowd',
      finisher: {
        name: c.finisherName || MOVES.find((m) => m.id === move)!.name, move,
        ...(c.finisherDescription.trim() ? { description: c.finisherDescription.trim() } : {}),
        ...(c.finisherCall.trim() ? { call: c.finisherCall.trim() } : {}),
      },
      ...profileOf(c),
      color: '',
    });
  }
  // Wrestlers pick first so the people who share the ring are the most distinct.
  for (const c of [...characters.filter((x) => x.role === 'wrestler'), ...characters.filter((x) => x.role !== 'wrestler' && x.role !== 'interviewer')]) {
    c.color = farthestColor(used, palette);
    used.push(c.color);
  }
  const byId = (raw: string) => {
    const id = idMap.get(raw) ?? raw;
    return characters.find((c) => c.id === id) ?? matchCharacter(raw, characters);
  };
  const wrestlersIn = (d: Division) => characters.filter((c) => c.role === 'wrestler' && c.division === d);
  const men = wrestlersIn('men').length;
  const women = wrestlersIn('women').length;
  if (men + women < 6 || Math.max(men, women) < 4) {
    problems.push(`need at least 6 wrestlers, with 4+ in one division (got ${men} men, ${women} women)`);
    return { world: null, problems };
  }

  const titleIds = new Set<string>();
  const titles = p.titles.flatMap((t) => {
    const pool = wrestlersIn(t.division);
    if (pool.length < 2) {
      problems.push(`title ${t.id}: the ${t.division} division needs at least 2 wrestlers`);
      return [];
    }
    let id = slug(t.id || t.name);
    while (titleIds.has(id)) id += '_2';
    titleIds.add(id);
    let holder = byId(t.holder);
    if (!holder || holder.role !== 'wrestler' || holder.division !== t.division) {
      problems.push(`title ${id}: holder "${t.holder}" is not a ${t.division} wrestler`);
      holder = rng.pick(pool);
    }
    return [{ id, name: t.name, division: t.division, holder: holder.id }];
  });
  if (!titles.length) problems.push('the promotion needs at least one title');

  const feuds = p.feuds.flatMap((f) => {
    const a = byId(f.a);
    const b = byId(f.b);
    if (!a || !b || a === b) {
      problems.push(`feud ${f.a} vs ${f.b}: unknown characters`);
      return [];
    }
    return [{ a: a.id, b: b.id, reason: f.reason, since: 0 }];
  });
  const alliances = p.alliances.flatMap((al) => {
    const members = al.members.map(byId).filter((c): c is Character => !!c).map((c) => c.id);
    return members.length >= 2 ? [{ name: al.name, members, since: 0 }] : [];
  });

  const world: World = {
    version: 2,
    showName: p.showName.trim() || 'Wrestling Weekly',
    shortName: (p.shortName.trim() || p.showName.trim()).slice(0, 6).toUpperCase(),
    direction,
    seed,
    crew: crewOf({ seed, crew: { pbp: p.commentators.playByPlay.trim(), color: p.commentators.color.trim() } }),
    episode: 0,
    characters,
    titles,
    feuds,
    alliances,
    notes: [],
    history: [],
    angleLog: [],
    storySoFar: p.storySoFar.trim(),
  };
  return { world, problems };
}

// ------------------------------------------------------------------ offline generator

const FIRST = [
  'Rex', 'Vic', 'Johnny', 'Earl', 'Tommy', 'Sam', 'Clint', 'Duke', 'Buck', 'Rocco', 'Nick', 'Hank', 'Dash', 'Otis',
  'Lex', 'Marco', 'Bobby', 'Jake', 'Ivan', 'Tito', 'Gus', 'Randy', 'Chet', 'Moose', 'Sid', 'Jimmy', 'Brock', 'Ace',
];
const FIRST_W = ['Roxy', 'Vicki', 'Dolly', 'Sheena', 'Candy', 'Tammy', 'Luna', 'Brandi', 'Misty', 'Jade', 'Raven', 'Trixie', 'Sable', 'Dixie'];
const LAST = [
  'Tolliver', 'Vega', 'Mosley', 'Harlan', 'Stryker', 'Bane', 'Kane', 'Steele', 'Blackwell', 'Cruz', 'Malone', 'Savage',
  'Rhodes', 'Ramone', 'Colt', 'Dupree', 'Kowalski', 'Knox', 'Sterling', 'Graves', 'Hawk', 'Lawless', 'Maddox', 'Voss',
];
const NICKS: Record<Style, string[]> = {
  brawler: ['Mad Dog', 'Bulldozer', 'Brass Knuckles', 'The Butcher', 'Wild Man', 'Crazy'],
  technician: ['The Professor', 'Mr. Perfect', 'The Surgeon', 'Textbook', 'The Technician'],
  powerhouse: ['The Titan', 'Big', 'The Mountain', 'Hercules', 'The Wall', 'Tank'],
  highflyer: ['Lightning', 'Flyin\'', 'Rocket', 'Skyhigh', 'The Comet', 'Kid'],
  showman: ['Slick', 'Hollywood', 'Gorgeous', 'Macho', 'Superstar', 'The Showstopper'],
};
const HARD_NICKS = ['The Sandman', 'Barbed Wire', 'Hardcore', 'The Maniac', 'Thumbtack', 'Chainsaw', 'Psycho'];
const GIMMICKS: Record<Style, string[]> = {
  brawler: ['A bar-fighting roughneck who settles everything with fists.', 'A trucker with a short fuse and a long memory.', 'A junkyard brawler who never learned the rules.'],
  technician: ['A cold, calculating mat wizard who holds everyone in contempt.', 'A disciplined ex-amateur champion obsessed with respect.', 'A snobbish aristocrat who calls the fans peasants.'],
  powerhouse: ['A towering strongman who bends steel bars on live TV.', 'A small-town hero with arms like tree trunks.', 'A silent monster with a mysterious past.'],
  highflyer: ['A neon-clad daredevil who lives on the top rope.', 'A skateboarding punk who answers to nobody.', 'A fearless kid who dreams of gold.'],
  showman: ['A glitter-robed playboy who never shuts up.', 'A B-movie star who treats every match like a screen test.', 'A preening rock-and-roll egomaniac.'],
};
const HARD_GIMMICKS = [
  'A hardcore maniac who brings a trash can full of weapons to every match.',
  'A barbed-wire-loving lunatic the fans chant for every night.',
  'A beer-swilling anti-hero who hits people with a Singapore cane.',
  'A table-breaking daredevil with no regard for their own body.',
];
const ENTRANCES = [
  'to a thundering drum anthem', 'to a screaming guitar riff', 'to a pompous military march', 'to a honky-tonk fiddle',
  'as the lights go red and a gong sounds', 'to a slot-machine jingle and saxophone', 'to howling dogs and chains',
  'under a spotlight to a movie fanfare', 'to a punk riff', 'to a synth-pop banger', 'to a bugle call', 'to church bells',
];
const MANAGERS = [
  { name: 'Sir Reginald Pemberton', gimmick: 'A posh, scheming manager with an umbrella and a checkbook.' },
  { name: 'Colonel Mustard Barnes', gimmick: 'A shouting ex-army manager who whips clients into shape.' },
  { name: 'Diamond Dallas Duvall', gimmick: 'A fast-talking agent who promises gold and delivers trouble.' },
];
const VALETS = [
  { name: 'Debbie Divine', gimmick: 'A glamorous valet whose loyalty is always for sale.' },
  { name: 'Miss Scarlett', gimmick: 'A mysterious valet who whispers in her client\'s ear.' },
  { name: 'Candi Cane', gimmick: 'A bubbly valet who is secretly the smartest person in the building.' },
];
const INTERVIEWERS = ['Lance Holloway', 'Gene Okerman', 'Marty Moss', 'Tony Schiavone-Smith', 'Mean Jean Hackett'];
const SHOWS = [
  ['Saturday Night Slam', 'SNS'], ['Championship Wrestling Hour', 'CWH'], ['Southern Heat', 'SHW'], ['Power Hour', 'PWR'],
  ['Friday Night Fury', 'FNF'], ['Mid-Atlantic Mayhem', 'MAM'], ['Big Time Wrestling', 'BTW'],
];
const HARD_SHOWS = [['Extreme Carnage', 'XCW'], ['Hardcore Heaven', 'HCW'], ['Bingo Hall Bloodbath', 'BHB'], ['Garage Riot Wrestling', 'GRW']];

const STYLES: Style[] = ['brawler', 'technician', 'powerhouse', 'highflyer', 'showman'];

const HOMETOWNS = [
  'Memphis, Tennessee', 'Charlotte, North Carolina', 'Amarillo, Texas', 'Detroit, Michigan', 'Tampa, Florida',
  'Brooklyn, New York', 'Minneapolis, Minnesota', 'Calgary, Alberta', 'San Juan, Puerto Rico', 'Beverly Hills, California',
  'Atlanta, Georgia', 'Philadelphia, Pennsylvania', 'Portland, Oregon', 'Kansas City, Missouri', 'Parts Unknown',
  'the Bayou of Louisiana', 'Las Vegas, Nevada', 'Boston, Massachusetts', 'Mobile, Alabama', 'Tokyo, Japan',
];
const WEIGHTS: Record<Style, [number, number]> = {
  brawler: [240, 300], technician: [220, 250], powerhouse: [280, 350], highflyer: [190, 225], showman: [220, 260],
};
const CATCHPHRASES: Record<Style, string[]> = {
  brawler: ['You want some? Come get some!', 'I fight dirty and I fight often!', 'Ring the bell and get outta my way!'],
  technician: ['Perfection is not an accident.', 'Wrestling is a science, and I am the professor!', 'Respect the hold!'],
  powerhouse: ['Nobody moves the mountain!', 'Feel the power!', 'I am UNSTOPPABLE!'],
  highflyer: ['The sky is not the limit!', 'Catch me if you can!', 'Time to fly!'],
  showman: ['Look at me! LOOK AT ME!', 'The show starts when I say it starts!', 'Nobody does it prettier!'],
};
/** How the desk describes each move when it is somebody's finisher. */
const FINISHER_LOOKS: Record<string, string> = {
  piledriver: 'a spike piledriver', lariat: 'a running lariat that could take a head off', ddt: 'a jumping DDT',
  big_splash: 'a splash with every ounce of body weight', spear: 'a shoulder-first spear through the midsection',
  figure_four: 'a figure-four leglock wrenched in the middle of the ring', belly_to_belly: 'a high-arcing belly-to-belly suplex',
  suplex: 'a delayed vertical suplex', boston_crab: 'a bone-bending Boston crab', armbar: 'a cross armbreaker',
  sleeper: 'a choking sleeper hold', powerbomb: 'a sit-out powerbomb', backbreaker: 'a spine-bending backbreaker',
  powerslam: 'a running powerslam', big_boot: 'a size-15 boot to the jaw', moonsault: 'a moonsault off the top rope',
  top_rope_splash: 'a splash off the top rope', top_rope_elbow: 'a flying elbow off the top', bulldog: 'a running bulldog',
  crossbody: 'a flying crossbody from the top', leg_drop: 'a leg drop across the throat', neckbreaker: 'a swinging neckbreaker',
};

export function isHardcore(direction: string): boolean {
  return /hardcore|extreme|ecw|garbage|deathmatch|violent|bloody/i.test(direction);
}

/** A random, valid promotion built from word banks. */
export function randomPromotion(seed: number, direction = ''): Promotion {
  const rng = new Rng(hashSeed('promotion', seed));
  const hard = isHardcore(direction);
  const usedNames = new Set<string>();
  const person = (pool: string[]) => {
    for (;;) {
      const n = `${rng.pick(pool)} ${rng.pick(LAST)}`;
      if (!usedNames.has(n)) {
        usedNames.add(n);
        return n;
      }
    }
  };
  const wrestler = (division: Division, alignment: NewCharacter['alignment']): NewCharacter => {
    const style = rng.pick(STYLES);
    const base = person(division === 'women' ? FIRST_W : FIRST);
    const nick = rng.chance(0.55) ? rng.pick(hard && rng.chance(0.5) ? HARD_NICKS : NICKS[style]) : null;
    const move = rng.pick(FINISHERS_BY_STYLE[style]);
    const last = base.split(' ')[1];
    return {
      id: slug(base), name: nick ? `"${nick}" ${base}` : base, role: 'wrestler', alignment, division, style,
      gimmick: hard && rng.chance(0.5) ? rng.pick(HARD_GIMMICKS) : rng.pick(GIMMICKS[style]),
      entrance: rng.pick(ENTRANCES),
      finisherName: rng.pick([`${last} Bomb`, `The ${last} Special`, `${last} Driver`, `${last}-quake`, `The Final ${last}`]),
      finisherMove: move,
      hometown: rng.pick(HOMETOWNS),
      weight: division === 'women' ? rng.int(118, 160) : rng.int(...WEIGHTS[style]),
      catchphrase: rng.pick(CATCHPHRASES[style]),
      finisherDescription: FINISHER_LOOKS[move] ?? '',
      finisherCall: '',
    };
  };
  const aligns = (n: number) => rng.shuffle(Array.from({ length: n }, (_, i) => (i % 5 === 4 ? 'tweener' : i % 2 ? 'heel' : 'face') as NewCharacter['alignment']));
  const men = aligns(rng.int(9, 11)).map((a) => wrestler('men', a));
  const women = aligns(rng.int(2, 4)).map((a) => wrestler('women', a));
  const mgr = rng.pick(MANAGERS);
  const val = rng.pick(VALETS);
  const heelsM = men.filter((c) => c.alignment === 'heel');
  const facesM = men.filter((c) => c.alignment === 'face');
  const manager: NewCharacter = {
    id: slug(mgr.name), name: mgr.name, role: 'manager', alignment: 'heel', division: 'men', style: 'showman',
    gimmick: mgr.gimmick, entrance: 'twirling a cane', finisherName: 'Cane Shot', finisherMove: 'punch',
    hometown: 'Park Avenue, New York', weight: 0, catchphrase: 'Everybody has a price!', finisherDescription: '', finisherCall: '',
  };
  const valet: NewCharacter = {
    id: slug(val.name), name: val.name, role: 'valet', alignment: rng.pick(['heel', 'face'] as const), division: 'women',
    style: 'showman', gimmick: val.gimmick, entrance: 'blowing kisses', finisherName: 'Slap', finisherMove: 'slap',
    hometown: 'Hollywood, California', weight: 0, catchphrase: 'Don\'t touch the hair!', finisherDescription: '', finisherCall: '',
  };
  const [show, short] = rng.pick(hard ? HARD_SHOWS : SHOWS);
  const champ = rng.pick(heelsM.length ? heelsM : men);
  const challenger = rng.pick(facesM.length ? facesM : men.filter((c) => c !== champ));
  const tvChamp = rng.pick(men.filter((c) => c !== champ));
  const wChamp = rng.pick(women);
  const clients = rng.shuffle(heelsM.filter((c) => c !== champ)).slice(0, 2);
  const valetClient = rng.pick(men.filter((c) => c.alignment === valet.alignment));
  const rival = rng.pick(men.filter((c) => c !== champ && c !== challenger && c !== tvChamp));
  const enemy = rng.pick(men.filter((c) => c.alignment !== rival.alignment && c !== champ && c !== challenger)) ?? tvChamp;
  const partner = rng.pick(facesM.filter((c) => c !== challenger)) ?? rival;
  const nm = (c: NewCharacter) => c.name.replace(/"[^"]*"\s*/g, '');
  return {
    showName: show,
    shortName: short,
    interviewer: { id: 'interviewer', name: rng.pick(INTERVIEWERS), gimmick: 'Veteran ring announcer and interviewer who is shocked every week.' },
    commentators: { playByPlay: '', color: '' },
    characters: [...men, ...women, manager, valet],
    titles: [
      { id: 'world', name: `${short} World Heavyweight Championship`, division: 'men', holder: champ.id },
      { id: 'tv', name: `${short} Television Championship`, division: 'men', holder: tvChamp.id },
      ...(women.length >= 2 ? [{ id: 'women', name: `${short} Women's Championship`, division: 'women' as const, holder: wChamp.id }] : []),
    ],
    feuds: [
      { a: challenger.id, b: champ.id, reason: `${nm(champ)} stole the world title from ${nm(challenger)} with a handful of tights.` },
      { a: rival.id, b: enemy.id, reason: `${nm(enemy)} ambushed ${nm(rival)} in the parking lot.` },
    ],
    alliances: [
      ...(clients.length ? [{ name: `The ${manager.name.split(' ').at(-1)} Establishment`, members: [manager.id, ...clients.map((c) => c.id)] }] : []),
      ...(valetClient ? [{ name: `${nm(valetClient).split(' ')[0]} & ${valet.name.split(' ')[0]}`, members: [valetClient.id, valet.id] }] : []),
      ...(partner && partner !== challenger ? [{ name: `${nm(challenger).split(' ')[1]} & ${nm(partner).split(' ')[1]}`, members: [challenger.id, partner.id] }] : []),
    ],
    storySoFar: `${nm(champ)} is the World Champion after cheating ${nm(challenger)}, who wants revenge. ` +
      `${nm(rival)} and ${nm(enemy)} are at war. ${manager.name} is recruiting muscle` +
      `${hard ? ', and the fans want blood, tables and barbed wire.' : '.'}`,
  };
}

export function offlineWorld(seed: number, direction = ''): World {
  const r = reviewPromotion(randomPromotion(seed, direction), direction, seed);
  if (!r.world) throw new Error(`offline promotion invalid: ${r.problems.join('; ')}`);
  return r.world;
}
