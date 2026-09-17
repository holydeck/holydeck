// The numbers every rendered frame in this system is measured against: the output aspect ratio, the
// safe-area margins, the absolute minimum readable text size, and the loudest a slide's own audio may
// play. REND-01 says administration owns them and a service may override them, while items and slides
// may not — so they are resolved once, here, and frozen. Nothing downstream re-reads a default; it reads
// the profile that came out of this file, which is why two surfaces cannot quietly disagree about the
// shape of the canvas they draw on.
//
// There is deliberately no settings route or admin screen behind this. No task owns one yet, so the
// defaults are a constructable value a caller passes in, not a row somebody has to have written first.
// When an administration surface does arrive it fills `AdministrativeRenderDefaults` and changes nothing
// else here.

export interface AspectRatio {
  readonly width: number;
  readonly height: number;
}

/** Each edge as a fraction of the canvas dimension it eats into. */
export interface SafeAreaMargins {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface Canvas {
  readonly width: number;
  readonly height: number;
}

export class RenderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderConfigurationError';
  }
}

/** REND-01: "a global output aspect ratio default, initially 16:9". */
export const DEFAULT_ASPECT_RATIO: AspectRatio = Object.freeze({ width: 16, height: 9 });

/** §11.6: "The validation default is 5% on every edge." */
export const DEFAULT_SAFE_AREA_MARGIN = 0.05;

/**
 * PROVISIONAL. The spec states a mechanism for the minimum readable size and no number for it: §19's gap
 * table books "representative-display validation of safe-area margins and minimum readable sizes" to the
 * maintainer, and §21 note 3 calls the minimum readable sizes "validation defaults awaiting measured
 * evidence". 4% of the resolved canvas height is a placeholder chosen to be replaced — roughly 43px on a
 * 1080-high canvas, about the smallest a back row can read off a sanctuary projector — not a measured
 * result. Replacing it when that evidence lands is this one line; every other rule about the floor
 * (per-output-type, raised by a Slide Layout box, never lowered by a service or an item) is already
 * built around it and does not change.
 */
export const PROVISIONAL_MINIMUM_READABLE_HEIGHT_RATIO = 0.04;

/**
 * The loudest a slide's own media may play, as a fraction of the output's own volume. One is "as loud as
 * the output is turned up", which is the only number that cannot surprise anybody the first time a
 * service plays a video; a house that wants its slides quieter than its band lowers this rather than
 * editing every item.
 */
export const DEFAULT_MAXIMUM_AUDIO_VOLUME = 1;

/**
 * The canvas every measurement and every frame is expressed against. Surfaces scale this at paint time;
 * none of them measures at its own pixel size, because two surfaces measuring separately is exactly the
 * divergence REND-01 forbids.
 */
export const REFERENCE_CANVAS_WIDTH = 1920;

/** Widest and narrowest custom ratio this release validates; 9:16 and 32:9 both sit inside it. */
export const RATIO_BOUNDS = Object.freeze({ min: 0.25, max: 4 });

export const safeAreaOf = (margin: number): SafeAreaMargins =>
  Object.freeze({ top: margin, right: margin, bottom: margin, left: margin });

export const DEFAULT_SAFE_AREA: SafeAreaMargins = safeAreaOf(DEFAULT_SAFE_AREA_MARGIN);

/** What administration may say about one output type, on top of what it says about all of them. */
export interface OutputTypeDefaults {
  readonly aspectRatio?: AspectRatio;
  readonly safeArea?: SafeAreaMargins;
  readonly minimumReadableHeightRatio?: number;
  readonly maximumAudioVolume?: number;
}

export interface AdministrativeRenderDefaults {
  readonly aspectRatio: AspectRatio;
  readonly safeArea: SafeAreaMargins;
  readonly minimumReadableHeightRatio: number;
  readonly maximumAudioVolume: number;
  readonly byOutputType: Readonly<Record<string, OutputTypeDefaults>>;
}

/**
 * What a service may override. The readable minimum is here too, but only ever upwards: §11.6 says
 * service and item settings "may not go below the administrative floor", so a lower number is clamped
 * rather than refused — a service asking for less readable text gets the floor, not an error page. The
 * volume bound is the same rule with the comparison mirrored, because it is a ceiling rather than a
 * floor: a service may be quieter than administration allows and never louder.
 */
export interface ServiceRenderOverrides {
  readonly aspectRatio?: AspectRatio;
  readonly safeArea?: SafeAreaMargins;
  readonly minimumReadableHeightRatio?: number;
  readonly maximumAudioVolume?: number;
}

export interface ResolvedOutputProfile {
  readonly outputType: string;
  readonly aspectRatio: AspectRatio;
  readonly safeArea: SafeAreaMargins;
  readonly minimumReadableHeightRatio: number;
  readonly maximumAudioVolume: number;
}

export const administrativeDefaults: AdministrativeRenderDefaults = Object.freeze({
  aspectRatio: DEFAULT_ASPECT_RATIO,
  safeArea: DEFAULT_SAFE_AREA,
  minimumReadableHeightRatio: PROVISIONAL_MINIMUM_READABLE_HEIGHT_RATIO,
  maximumAudioVolume: DEFAULT_MAXIMUM_AUDIO_VOLUME,
  byOutputType: Object.freeze({}),
});

const positive = (value: number): boolean => Number.isFinite(value) && value > 0;

export function validateAspectRatio(ratio: AspectRatio): AspectRatio {
  if (!positive(ratio.width) || !positive(ratio.height)) {
    throw new RenderConfigurationError(`aspect ratio ${ratio.width}:${ratio.height} is not two positive numbers`);
  }
  const shape = ratio.width / ratio.height;
  if (shape < RATIO_BOUNDS.min || shape > RATIO_BOUNDS.max) {
    throw new RenderConfigurationError(
      `aspect ratio ${ratio.width}:${ratio.height} is outside the validated range ${RATIO_BOUNDS.min}-${RATIO_BOUNDS.max}`,
    );
  }
  return Object.freeze({ width: ratio.width, height: ratio.height });
}

export function validateSafeArea(safeArea: SafeAreaMargins): SafeAreaMargins {
  for (const [edge, margin] of Object.entries(safeArea)) {
    if (!Number.isFinite(margin) || margin < 0 || margin >= 0.5) {
      throw new RenderConfigurationError(`safe-area margin ${edge}=${margin} is not a fraction below half the canvas`);
    }
  }
  return Object.freeze({ ...safeArea });
}

export function validateMinimumReadableHeightRatio(ratio: number): number {
  if (!positive(ratio) || ratio > 0.5) {
    throw new RenderConfigurationError(`minimum readable height ratio ${ratio} is not a fraction of the canvas height`);
  }
  return ratio;
}

/**
 * Zero is allowed and one is the ceiling: an administrator who wants slide audio silent has said so, and
 * a bound above the output's own volume is a number nothing could honour.
 */
export function validateMaximumAudioVolume(volume: number): number {
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
    throw new RenderConfigurationError(`maximum audio volume ${volume} is not a fraction of the output volume`);
  }
  return volume;
}

/** The reference canvas for a ratio. Integer pixels, so the same ratio is the same canvas everywhere. */
export function canvasFor(ratio: AspectRatio, width: number = REFERENCE_CANVAS_WIDTH): Canvas {
  return Object.freeze({ width, height: Math.round((width * ratio.height) / ratio.width) });
}

export interface OutputProfileRequest {
  readonly outputType: string;
  readonly defaults?: AdministrativeRenderDefaults;
  readonly service?: ServiceRenderOverrides;
}

/**
 * Administration, then this output type, then the service — each layer overriding the one before, except
 * the readable floor, which a service may only ever raise, and the volume bound, which it may only ever
 * lower.
 *
 * The floor is resolved the same way the other two are: the output type's own number when administration
 * gave it one, the global default when it did not. §11.6 says administration "defines an absolute minimum
 * readable size per output type", so a type that was configured has been given its floor — a stage display
 * set deliberately lower than the wall is a configuration, not a number to be corrected upwards by the
 * global default. What does not fall is the service layer on top of it.
 *
 * Every number that leaves here has been through its validator, the service's included: the resolved floor
 * is what the auto-fit ladder steps down to, and a `NaN` or an out-of-range fraction reaching it is a loop
 * that does not terminate rather than a configuration error anybody can read.
 */
export function resolveOutputProfile({
  outputType,
  defaults = administrativeDefaults,
  service,
}: OutputProfileRequest): ResolvedOutputProfile {
  const perType = defaults.byOutputType[outputType] ?? {};
  const floor = validateMinimumReadableHeightRatio(
    perType.minimumReadableHeightRatio ?? defaults.minimumReadableHeightRatio,
  );
  const ceiling = validateMaximumAudioVolume(perType.maximumAudioVolume ?? defaults.maximumAudioVolume);

  return Object.freeze({
    outputType,
    aspectRatio: validateAspectRatio(service?.aspectRatio ?? perType.aspectRatio ?? defaults.aspectRatio),
    safeArea: validateSafeArea(service?.safeArea ?? perType.safeArea ?? defaults.safeArea),
    minimumReadableHeightRatio: validateMinimumReadableHeightRatio(
      Math.max(floor, service?.minimumReadableHeightRatio ?? 0),
    ),
    maximumAudioVolume: validateMaximumAudioVolume(Math.min(ceiling, service?.maximumAudioVolume ?? ceiling)),
  });
}
