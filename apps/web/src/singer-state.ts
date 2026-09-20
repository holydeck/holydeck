// What a Singer may do that no other output surface may (LIVE-18): read somewhere else in the song
// that is up, privately, while the operator keeps running the service — and come back to the live
// slide in one action when the cue says the operator has moved on.
//
// This is not `live-mode.ts`'s privacy model, despite sharing the word "position". That model's `mode`
// belongs to the *shared* run: Control drives it, Audience and Guest read it through `publicFrameOf`,
// and `pause()` there holds the public output still for everyone watching. What LIVE-18 asks for is the
// opposite of shared — one musician's own client looking two slides ahead while the service continues
// underneath them, with the public output, the operator's panel and every other Singer's screen
// completely unaffected. So nothing below has a mode, and nothing below can reach the shared session at
// all: the only writer of `publicPosition` here is `moveLive`, which is the operator's move arriving,
// and the only writer of `browsedPosition` is this one Singer's own browsing. Two fields, two writers,
// no path between them — which is the whole of the locality guarantee, provable by construction rather
// than by remembering to check a mode first.
//
// Nor is this `stage-state.ts`'s look-ahead. Stage reads on across item boundaries because a musician
// watching it needs to know what is coming after this song; a Singer browsing is inside the song they
// are singing — "the current song", verbatim — so a position here is one slide index into one song, the
// shape `control-state.ts` already resolves positions in. And a position is all it is: the words at one
// are `stage-state.ts`'s `surfaceCue`, which already renders exactly what a non-Stage surface shows in
// the language it is reading. Nothing here re-derives that, so a Singer's language selection stays that
// module's one question rather than becoming two modules' half-answers.

/**
 * The song the operator currently has up, reduced to what browsing it needs: which song it is, and how
 * far it runs. Deliberately not `ServiceItem` or a `Song`, for the same reason `control-state.ts`'s
 * `OrderItem` is neither — every rule below is then provable without a stored shape to build first.
 */
export interface SingerSong {
  readonly id: string;
  /** How many slides this song has. Zero is a real case — an item with nothing to show — and browsing
   *  it is refused rather than clamped, since there is no slide to be parked on. */
  readonly slideCount: number;
}

/**
 * One Singer's client, and only that client. `publicPosition` is the slide the operator has live, which
 * browsing never writes; `browsedPosition` is where this Singer is privately looking.
 *
 * `undefined` there means following the operator, which is a different state from "browsing a slide that
 * happens to be the live one" even though both render the same words. A Singer who deliberately browsed
 * onto the live slide stays where they put themselves when the operator advances, and is told that the
 * operator moved; a Singer who never browsed simply moves with them. Inferring that from the two indexes
 * being equal would silently reattach the first Singer at exactly the moment they most need to be asked.
 */
export interface SingerView {
  readonly songId: string;
  readonly publicPosition: number;
  readonly browsedPosition: number | undefined;
}

/** Where the live slide is, relative to the one this Singer is reading, and how far off it is. */
export interface AwayFromLive {
  readonly livePosition: number;
  /** `ahead` when the operator has moved past what this Singer is reading, `behind` when this Singer
   *  has read on past the operator. */
  readonly direction: 'ahead' | 'behind';
  readonly slides: number;
}

/**
 * What a Singer's screen draws: the slide they are reading, whether they are browsing at all — the
 * "return to live" affordance is theirs to show or not — and the cue itself.
 *
 * `awayFromLive` is absent, not an emptied object, whenever this Singer is reading the live slide, so a
 * renderer has nothing to draw rather than something blank. It is therefore absent for every following
 * Singer by construction, and present only while a browsing one is somewhere the operator is not.
 */
export interface SingerCue {
  readonly position: number;
  readonly browsing: boolean;
  readonly awayFromLive?: AwayFromLive;
}

/** A song with no slides collapses every position onto 0; nothing is ever read at it, because the two
 *  calls that could put a Singer there refuse it outright. */
const clampSlide = (song: SingerSong, slide: number): number =>
  song.slideCount <= 0 ? 0 : Math.min(Math.max(slide, 0), song.slideCount - 1);

/** A Singer joining, or a fresh song: on the live slide, browsing nothing. */
export function initialSingerView(song: SingerSong, publicPosition = 0): SingerView {
  return { songId: song.id, publicPosition: clampSlide(song, publicPosition), browsedPosition: undefined };
}

/** The slide this Singer is actually reading — their own, while they are browsing, and the operator's
 *  otherwise. The one place the two positions are ever collapsed into one answer. */
export function singerPosition(view: SingerView): number {
  return view.browsedPosition ?? view.publicPosition;
}

/**
 * This Singer looking somewhere else in the song that is up. Writes `browsedPosition` and nothing else,
 * which is what makes browsing invisible to the public output rather than merely undisplayed on it.
 *
 * Refused, leaving the Singer exactly as they were, for a song with no slides and for a song other than
 * the one this view is on: browsing is scoped to the current song, and a slide index means nothing
 * outside the song it indexes.
 */
export function browseTo(song: SingerSong, view: SingerView, slide: number): SingerView {
  if (song.id !== view.songId || song.slideCount <= 0) return view;
  return { ...view, browsedPosition: clampSlide(song, slide) };
}

/** Paging through the song by hand: relative to where this Singer is reading, not to where the operator
 *  is, so a first step away from a followed position lands next to what is live rather than jumping. */
export function browseBy(song: SingerSong, view: SingerView, slides: number): SingerView {
  return browseTo(song, view, singerPosition(view) + slides);
}

/**
 * The operator's move arriving at this client. Writes `publicPosition` alone while the song is the same
 * one — a Singer who is browsing keeps browsing, and is told by the cue below — and re-anchors the view
 * onto the new song when the operator has moved on to one, abandoning browsing with it, since a slide of
 * a song no longer up is not somewhere anyone can still be reading.
 */
export function moveLive(song: SingerSong, view: SingerView, publicPosition: number): SingerView {
  const at = clampSlide(song, publicPosition);
  return song.id === view.songId
    ? { ...view, publicPosition: at }
    : { songId: song.id, publicPosition: at, browsedPosition: undefined };
}

/** The operator's next slide: the one after the live one within this song, held at the last rather than
 *  running past it, and the first slide of the song when this is the operator arriving on a new one. */
export function advanceLive(song: SingerSong, view: SingerView): SingerView {
  return moveLive(song, view, song.id === view.songId ? view.publicPosition + 1 : 0);
}

/** `Return to Live Position`: one call, giving up whatever was being browsed and reading the live slide
 *  again. It cannot move the public output, because it does not write `publicPosition` at all. */
export function returnToLive(view: SingerView): SingerView {
  return { ...view, browsedPosition: undefined };
}

/** What this Singer's screen shows and is told, derived wholly from the two positions — so the cue is
 *  never stale, and never has to be delivered by anything but the state itself already being there. */
export function singerCue(view: SingerView): SingerCue {
  const position = singerPosition(view);
  const cue: SingerCue = { position, browsing: view.browsedPosition !== undefined };
  const slides = view.publicPosition - position;
  if (slides === 0) return cue;
  return {
    ...cue,
    awayFromLive: {
      livePosition: view.publicPosition,
      direction: slides > 0 ? 'ahead' : 'behind',
      slides: Math.abs(slides),
    },
  };
}
