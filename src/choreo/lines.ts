// Phrase banks for connective narration. Placeholders: {A} actor/attacker, {D} defender,
// {W} winner, {L} loser, {X} anyone, {T} title, {F} finisher name, {E} entrance flavor,
// {S} show name. Names are always used instead of pronouns.
import type { Rng } from '../engine/rng';

export const LINES = {
  showOpen: [
    'Welcome, fans, to another edition of {S}! What a crowd we have tonight!',
    'Hello everybody, and welcome to {S}! The place is PACKED!',
    'It\'s time for {S}! Buckle up, fans, because anything can happen!',
    'Good evening and welcome to {S}! The atmosphere here is electric!',
  ],
  showClose: [
    'That\'s all the time we have! We\'ll see you next week on {S}!',
    'What a night! Until next time, fans — so long from {S}!',
    'We\'re out of time! Stay tuned next week, right here on {S}!',
  ],
  commercial: [
    'We\'ll be right back after these messages!',
    'Don\'t go anywhere, fans — more action after the break!',
    'Stay tuned! You won\'t believe what\'s coming up next!',
    'Let\'s take a quick break. When we come back, the fireworks continue!',
  ],
  music: [
    'Wait a minute... that music! Here comes {A}!',
    'The music hits and here comes {A}, {E}!',
    'Out from the back, {E}, it\'s {A}!',
    '{A} emerges from the curtain, {E}!',
  ],
  musicInterrupt: [
    'WAIT! That\'s {A}\'s music!',
    'Hold on! Somebody\'s coming out... it\'s {A}!',
    'The lights flicker... and {A} appears on the stage!',
    'Oh my goodness, look who it is! {A}!',
  ],
  walkFace: [
    '{A} slaps hands with the fans on the way down.',
    '{A} soaks in the cheers from this crowd.',
    'The fans are going wild for {A}!',
  ],
  walkHeel: [
    '{A} sneers at the booing fans.',
    '{A} jaws with a fan at ringside. Security, please!',
    '{A} struts down the aisle like royalty. The crowd hates it!',
  ],
  sprint: [
    '{A} SPRINTS down the aisle!',
    'Here comes {A} at full speed!',
    '{A} is charging toward the ring!',
  ],
  stagePose: [
    '{A} poses on the stage as the crowd reacts.',
    '{A} stops at the top of the ramp, taking it all in.',
  ],
  turnbucklePose: [
    '{A} climbs the turnbuckle and poses for the crowd!',
    '{A} raises both arms in the corner!',
  ],
  interviewIntro: [
    'Let\'s go back to Lance Holloway at the interview podium.',
    'Our interviewer is standing by with a special guest.',
    'Let\'s head over to the podium, where things are already heating up.',
  ],
  interviewShove: [
    '{A} shoves the interviewer aside and storms off!',
    '{A} snatches the microphone away!',
  ],
  mic: [
    '{A} grabs a microphone.',
    '{A} calls for a mic.',
    'Somebody hands {A} a microphone...',
  ],
  sneak: [
    'Look out! {A} is sneaking up from behind!',
    'Wait... who is that coming through the crowd? It\'s {A}!',
    '{A} creeps up behind {D}...',
  ],
  ambush: [
    '{A} jumps {D} from behind!',
    'Cheap shot! {A} blindsides {D}!',
    '{A} attacks! {D} never saw it coming!',
  ],
  beatdown: [
    '{A} is putting the boots to {D}!',
    'This is a mugging! {A} won\'t let up!',
    'Somebody stop this! {A} is destroying {D}!',
  ],
  standOver: [
    '{A} stands over the fallen {D}.',
    '{A} poses over {D}\'s motionless body.',
    '{A} spits on {D}. Disgusting!',
  ],
  save: [
    'Here comes {A} to make the save!',
    '{A} hits the ring to clean house!',
    '{A} rushes in for the save!',
  ],
  flee: [
    '{A} bails out of the ring!',
    '{A} retreats up the aisle!',
    '{A} runs for the hills!',
  ],
  stareDown: [
    '{A} and {D} are nose to nose! You could cut the tension with a knife!',
    'A tense stare-down between {A} and {D}!',
  ],
  shove: [
    '{A} shoves {D}!',
    '{A} pushes {D} back hard!',
  ],
  slapFace: [
    'SLAP! {A} just slapped {D} across the face!',
    '{A} slaps the taste out of {D}\'s mouth!',
  ],
  brawl: [
    'A fight breaks out between {A} and {D}!',
    'Here we go! {A} and {D} are brawling!',
    'Fists are flying! {A} and {D} are going at it!',
  ],
  separated: [
    'Officials rush out to separate {A} and {D}!',
    'Security is pulling {A} and {D} apart!',
  ],
  // ---- reactions
  shock: ['{A} is in shock!', '{A} can\'t believe it!', '{A}\'s jaw is on the floor!'],
  laugh: ['{A} bursts out laughing!', '{A} cackles!', '{A} is laughing hysterically!'],
  anger: ['{A} is furious!', '{A} is seething with rage!', '{A} looks ready to explode!'],
  cry: ['{A} breaks down in tears!', '{A} is sobbing!'],
  faint: ['{A} FAINTS!', '{A} collapses to the mat!'],
  cheer: ['{A} is thrilled!', '{A} pumps a fist!'],
  smirk: ['{A} smirks.', '{A} just smiles...', 'A sinister grin from {A}.'],
  disbelief: ['{A} shakes their head in disbelief!', '{A} is stunned!'],
  crowdGasp: ['The crowd gasps!', 'You could hear a pin drop!', 'The fans are stunned into silence!'],
  // ---- turns
  turnAttack: [
    '{A} HAS TURNED ON {D}!',
    'NO! {A} just betrayed {D}!',
    '{A} attacks {D}! What is going on?!',
  ],
  turnJoin: [
    '{A} is shaking hands with {D}! {A} has sold out!',
    '{A} has joined forces with {D}!',
  ],
  turnSave: [
    '{A} is saving {D}?! Has {A} seen the light?',
    'Unbelievable! {A} came out to help {D}!',
  ],
  turnWalk: [
    '{A} turns their back and walks out!',
    '{A} has had enough, and just walks away!',
  ],
  turnCommentary: [
    'I can\'t believe what I\'m seeing!',
    'The whole landscape of {S} has changed tonight!',
    'Fans, we are witnessing history!',
  ],
  // ---- exits
  exitWalk: ['{A} heads to the back.', '{A} walks up the aisle.'],
  exitStorm: ['{A} storms off in a rage!', '{A} kicks the barricade and stomps to the back!'],
  exitStagger: ['{A} staggers to the back.', '{A} can barely stand.'],
  exitHelped: ['{A} is helped to the back.', 'Officials help {A} to the back.'],
  celebrate: [
    '{A} celebrates with the fans!',
    '{A} raises their arms in victory!',
    '{A} is on top of the world!',
  ],
  // ---- match
  bell: [
    'DING DING! Here we go!',
    'The bell rings and we are underway!',
    'The referee calls for the bell!',
  ],
  titleIntro: [
    'This contest is for the {T}!',
    'The {T} is on the line!',
    'Gold is at stake! This is for the {T}!',
  ],
  lockup: [
    '{A} and {D} lock up in the center of the ring.',
    'Collar-and-elbow tie-up between {A} and {D}.',
    '{A} and {D} circle each other...',
  ],
  stall: [
    '{A} rolls out of the ring to stall. The crowd is not happy!',
    '{A} begs off in the corner! "No, no, wait!"',
    '{A} takes a breather and jaws at the fans.',
  ],
  taunt: [
    '{A} plays to the crowd!',
    '{A} flexes for the fans!',
    '{A} struts around the ring!',
    '{A} yells at the camera!',
  ],
  headlock: [
    '{A} grinds on a side headlock, wearing {D} down.',
    '{A} slows things down with a rear chinlock.',
  ],
  headlockEscape: [
    'The crowd claps to rally {D}... and {D} fights out with elbows!',
    '{D} powers out of the hold!',
  ],
  comeback: [
    '{A} is fired up! The crowd is on its feet!',
    '{A} shrugs off the blows! Here comes the comeback!',
    '{A} fights back with a flurry of right hands!',
    '{A} is feeding off this crowd!',
  ],
  cutoff: [
    '{A} cuts off the comeback with a cheap shot!',
    '{A} takes over again!',
    'Just as {D} was rallying, {A} slams the door shut!',
  ],
  bothDown: [
    'Both competitors are down!',
    'Nobody\'s moving! The referee checks on both of them...',
    'A double knockdown! This crowd is going crazy!',
  ],
  pullUp: [
    '{A} pulls {D} up by the hair.',
    '{A} drags {D} back up.',
    '{A} yanks {D} off the mat.',
  ],
  kickout: [
    'KICKOUT! {D} kicks out!',
    'NO! Just barely! {D} got the shoulder up!',
    'Two and a HALF! So close!',
    '{D} kicks out at the last second!',
  ],
  refWarn: ['The referee is giving {A} an earful!', 'The ref warns {A}!'],
  cheatUnseen: ['...and the referee didn\'t see a thing!', 'The ref was looking the other way!'],
  subStruggle: ['{D} is in agony!', '{D} reaches for the ropes...', 'The crowd is willing {D} to the ropes!'],
  subEscape: ['{D} makes it to the ropes! The hold is broken!', '{D} powers out of the hold!'],
  tapout: ['{D} TAPS OUT! It\'s over!', '{D} can\'t take it anymore! {D} gives up!'],
  finisherCall: [
    '{A} is setting up the {F}!',
    'Here it comes... the {F}!',
    '{A} signals for the {F}! The crowd knows what\'s coming!',
  ],
  finisherHit: ['{F}! {A} hits the {F}!', '{A} NAILS THE {F}!'],
  rollupSetup: [
    '{L} goes for the kill—',
    '{L} is gloating, arms raised...',
    '{L} turns to taunt the crowd—',
  ],
  rollupHit: [
    'But {W} ROLLS {L} UP OUT OF NOWHERE!',
    'SMALL PACKAGE by {W}!',
    '{W} cradles {L}!',
  ],
  cheatPin: [
    '{W} covers with feet on the ropes! The referee doesn\'t see it!',
    '{W} grabs a handful of tights on the cover!',
    '{W} puts both feet on the ropes for leverage!',
  ],
  dq: [
    'The referee is calling for the bell! {L} has been disqualified!',
    'That\'s it! The ref has seen enough! {L} is DISQUALIFIED!',
  ],
  dqCause: [
    '{L} grabs a steel chair! The referee sees it!',
    '{L} won\'t break the choke! The ref is counting... 4... 5!',
    '{L} shoves the referee!',
  ],
  countoutSpill: [
    '{A} and {D} spill out to the floor!',
    'They\'re fighting on the outside!',
  ],
  countoutBeat: [
    '{W} rolls back into the ring at the count of nine!',
    '{W} slides in just in time!',
  ],
  countoutLoss: [
    '{L} didn\'t make it back! Count-out!',
    'Ten! {L} has been counted out!',
  ],
  noContest: [
    'The referee has lost control! He\'s calling for the bell!',
    'This match has been thrown out! Total chaos!',
    'No contest! This has broken down completely!',
  ],
  winner: [
    'Here is your winner... {W}!',
    'Your winner: {W}!',
    'And the winner of this contest... {W}!',
  ],
  newChamp: [
    'AND NEEEEW {T} CHAMPION... {W}!',
    'WE HAVE A NEW CHAMPION! {W} is the new {T} champion!',
    'THE BELT HAS CHANGED HANDS! {W} is your new {T} champion!',
  ],
  retain: [
    '...and STILL {T} champion, {W}!',
    '{W} is still the {T} champion!',
  ],
  titleNoChange: [
    'But the title can\'t change hands on a {how}! {W} wins, but no new champion!',
    'The champion loses, but the belt stays put on a {how}!',
  ],
  refBump: [
    'OH NO! The referee got caught in the crossfire! The ref is down!',
    '{A} crashes into the referee! Nobody is in charge now!',
  ],
  refUp: ['The referee is groggy, but back up.', 'The ref is back on his feet.'],
  distract: [
    '{A} jumps up on the apron to distract the referee!',
    '{A} is arguing with the referee!',
  ],
  distractCheat: [
    'And while the ref is distracted, {A} takes a cheap shot at {D}!',
    'Behind the ref\'s back, {A} goes to work on {D}!',
  ],
  weapon: [
    '{A} slides a chair into the ring!',
    '{A} has a weapon!',
  ],
  runIn: [
    'HERE COMES {A}! {A} is running to the ring!',
    '{A} hits the ring out of nowhere!',
    'It\'s {A}! Charging down the aisle!',
  ],
  interruptLook: [
    '{A} and {D} both stop and stare at the stage.',
    'Everyone in the ring turns to look!',
    'The action stops as everyone looks toward the entrance!',
  ],
  distracted: [
    '{A} is distracted by all of this...',
    '{A} can\'t take their eyes off the stage...',
  ],
  cheapShotAfter: [
    '...and {A} takes advantage with a cheap shot on {D}!',
    '{A} clubs {D} from behind while {D} was distracted!',
  ],
  weaponHit: [
    '{A} grabs a {X}... WHAM! Right across {D}\'s skull!',
    '{A} swings the {X} and {D} goes down hard!',
    'OH MY! {A} just blasted {D} with a {X}!',
    '{A} has a {X}! {D} never had a chance!',
  ],
  weapons: ['steel chair'],
  hardcoreWeapons: [
    'steel chair', 'trash can', 'kendo stick', 'cookie sheet', 'barbed-wire bat', 'frying pan', 'stop sign', 'road sign', 'fire extinguisher',
  ],
  chants: {
    face: ['Let\'s go {X}!', '{X}! {X}! {X}!', 'We want {X}!'],
    heel: ['{X} sucks!', 'Boring!', 'You can\'t wrestle!'],
    any: ['This is awesome!', 'Holy cow!', 'Let\'s go!'],
  },
} as const;

export type LineKey = Exclude<keyof typeof LINES, 'chants' | 'weapons' | 'hardcoreWeapons'>;

/** "Warehouse Championship" -> "Warehouse", so "{T} champion" reads naturally. */
export function beltName(title: string): string {
  return title.replace(/\s+(championship|title|belt)$/i, '').trim() || title;
}

/** Finisher names often start with "The"; templates already say "the {F}". */
export function finisherName(name: string): string {
  return name.replace(/^the\s+/i, '');
}

export function fill(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w)\}|\{how\}/g, (m, k: string | undefined) => {
    const key = k ?? 'how';
    return vars[key] ?? m;
  });
}

export function line(rng: Rng, key: LineKey, vars: Record<string, string> = {}): string {
  return fill(rng.pick(LINES[key] as readonly string[]), vars);
}
