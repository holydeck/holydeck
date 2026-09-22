// The shell's small piece of shared state lives apart from rendering and transport so every screen reads
// the same session, onboarding and locale facts without turning browser storage into an authentication
// boundary. These values are intentionally memory-only: a reload asks the server again.

import type { OnboardingOffer } from '@holydeck/contracts/accounts';
import type { SessionView } from '@holydeck/contracts/sessions';
import { localeFor, type Locale } from '@holydeck/localization/locales';
import { signal, type Signal } from '@preact/signals';

const initialLocale = (): Locale => localeFor(globalThis.navigator?.languages ?? []);

/** The session answer: not yet asked, signed out, or the parsed session the server just verified. */
export const session: Signal<SessionView | null | undefined> = signal(undefined);

/** The first-run offer, a claimed installation, or the still-unanswered state before boot completes. */
export const onboarding: Signal<OnboardingOffer | 'claimed' | undefined> = signal(undefined);

/** The device language chosen from the shipped catalogues before any screen begins to render. */
export const locale: Signal<Locale> = signal(initialLocale());

/** Whether the server refused this client because its released contract window is now too old. */
export const updateRequired: Signal<boolean> = signal(false);

/** The session token a changing request must return to the server, or nothing before a session exists. */
export function csrf(): string | undefined {
  return session.value?.csrf;
}

/** Whether the verified session grants one named permission, never inferred from its account role. */
export function can(permission: string): boolean {
  return session.value?.permissions.includes(permission) ?? false;
}

/** Restores the memory-only state a fresh application load begins with. */
export function resetAppState(): void {
  session.value = undefined;
  onboarding.value = undefined;
  locale.value = initialLocale();
  updateRequired.value = false;
}
