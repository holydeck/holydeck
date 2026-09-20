// A slide group's own backing track (LIVE-20), driven by exactly the machinery `./live-media.js` already
// built for a single slide's media. `createSlideGroupAudioController` wraps a `MediaAuthority` and decides,
// on every slide taken live, whether anything about the group's track has to move — using
// `@holydeck/contracts/live-media`'s `slideGroupAudioAction` for the decision itself, and owning nothing
// more than the two pieces of state that decision needs from outside a pure function: which group was on
// screen last, and where a stopped group's track was left. Starting, pausing, seeking, drift correction,
// and failure reporting are all the authority's, unchanged from T87 — this module adds a second caller of
// that machinery, not a second implementation of it.
//
// Standby and Paused hold public output without stopping a running track (test bullet 7) for the same
// reason this controller never sees them: neither is a `PresentedSlideGroup`, so neither ever reaches
// `present()`, and a decision this module never makes cannot stop anything. The only thing that can leave
// a group here is another call to `present()` naming a different one — an operator's own transport act.

import { slideGroupAudioAction } from '@holydeck/contracts/live-media';

import type {
  PresentedSlideGroup,
  SlideGroupAudioAction,
  SlideGroupAudioMemory,
} from '@holydeck/contracts/live-media';
import type { MediaAuthority, MediaSettings } from './live-media.js';

/** What a group's track needs beyond which one it is and where to start — the same fields `MediaSettings`
 *  already asks of a single slide's media, minus the two this controller resolves for itself from the
 *  decision it just made. */
export type SlideGroupAudioSettings = Omit<MediaSettings, 'mediaId' | 'startAtMs'>;

export interface SlideGroupAudioController {
  /**
   * A slide went live. Decides what its group's track does and, for a `'start'`, drives the authority
   * through it — the same authoritative `take()` a single slide's media already goes through, so the start
   * reaches Audience as an authoritative command exactly as any other media take does. `settingsFor` is
   * only ever called for a `'start'`, never for a group with nothing to play or one already running.
   *
   * Returns the decision itself, so a caller with something else to do with it — recording the run event
   * LIVE-12 asks for, say — has it without re-deriving it from the same two slides.
   */
  present(
    next: PresentedSlideGroup,
    event: { readonly at: string },
    settingsFor: (audioTrackId: string) => SlideGroupAudioSettings,
  ): Promise<SlideGroupAudioAction>;
}

export function createSlideGroupAudioController(authority: MediaAuthority): SlideGroupAudioController {
  let previous: PresentedSlideGroup | undefined;
  let memory: SlideGroupAudioMemory = {};

  return {
    async present(next, event, settingsFor): Promise<SlideGroupAudioAction> {
      // Leaving a group whose track was playing is the one moment this controller has to act before the
      // pure decision is even asked for: only the authority knows the position playback actually reached,
      // and that has to be frozen into memory now, while `previous` still names the group it belongs to.
      if (previous !== undefined && previous.slideGroupId !== next.slideGroupId && previous.audioTrackId !== undefined) {
        authority.pause();
        const timeline = authority.timeline;
        if (timeline !== undefined) memory = { ...memory, [previous.slideGroupId]: timeline.anchorPositionMs };
      }

      const action = slideGroupAudioAction(previous, next, memory);
      previous = next;

      if (action.kind === 'start') {
        await authority.take(event, {
          ...settingsFor(action.audioTrackId),
          mediaId: action.audioTrackId,
          startAtMs: action.startAtMs,
        });
      }

      return action;
    },
  };
}
