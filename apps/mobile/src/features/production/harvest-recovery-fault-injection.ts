import Constants from 'expo-constants';

export type HarvestRecoveryFaultPoint =
  'after_prepared' | 'after_posting' | 'after_accepted' | 'after_reconciled';

export type HarvestRecoveryStorageOperation = 'read' | 'write' | 'verification_read' | 'delete';

export type HarvestRecoveryFault =
  | { kind: 'checkpoint'; point: HarvestRecoveryFaultPoint }
  | { kind: 'storage_failure'; operation: HarvestRecoveryStorageOperation }
  | { kind: 'corrupt_empty_record' };

export interface HarvestRecoveryFaultSnapshot {
  armed: HarvestRecoveryFault | null;
  pausedAt: HarvestRecoveryFaultPoint | null;
}

const listeners = new Set<() => void>();
let snapshot: HarvestRecoveryFaultSnapshot = { armed: null, pausedAt: null };
// QA generations identify injection ownership only; they never grant submission authority.
export type HarvestRecoveryFaultAttempt = symbol | null;
let currentAttempt = Symbol('harvest QA generation');
let attemptActive = false;
let armedAttempt: HarvestRecoveryFaultAttempt = null;

export function captureHarvestRecoveryFaultAttempt(): HarvestRecoveryFaultAttempt {
  return isHarvestRecoveryFaultInjectionEnabled() ? currentAttempt : null;
}

function ownsFault(attempt: HarvestRecoveryFaultAttempt): boolean {
  return attempt !== null && attempt === currentAttempt && attempt === armedAttempt;
}
let releasePause: (() => void) | null = null;
let pauseOwner: HarvestRecoveryFaultAttempt = null;

export function isHarvestRecoveryFaultInjectionEnabled(): boolean {
  const config = Constants.expoConfig;
  const extra = config?.extra;
  return (
    process.env.EXPO_PUBLIC_FD_QA_FAULT_INJECTION === 'true' &&
    extra?.appVariant === 'fdqa' &&
    extra?.fdQaFaultInjection === true &&
    config?.ios?.bundleIdentifier === 'com.agrovix.agos.fdqa' &&
    config?.android?.package === 'com.agrovix.agos.fdqa'
  );
}

function publish(next: HarvestRecoveryFaultSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

export function getHarvestRecoveryFaultSnapshot(): HarvestRecoveryFaultSnapshot {
  return snapshot;
}

export function subscribeHarvestRecoveryFaults(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function armHarvestRecoveryFault(
  fault: HarvestRecoveryFault,
  attempt = captureHarvestRecoveryFaultAttempt(),
): boolean {
  if (
    !isHarvestRecoveryFaultInjectionEnabled() ||
    attempt !== currentAttempt ||
    snapshot.armed ||
    snapshot.pausedAt
  ) {
    return false;
  }
  armedAttempt = attempt;
  publish({ armed: fault, pausedAt: null });
  return true;
}

/** Cancels only an unused selection. A paused mutation still requires explicit release. */
export function disarmHarvestRecoveryFault(
  attempt = captureHarvestRecoveryFaultAttempt(),
): boolean {
  if (
    !isHarvestRecoveryFaultInjectionEnabled() ||
    !ownsFault(attempt) ||
    !snapshot.armed ||
    snapshot.pausedAt
  )
    return false;
  publish({ armed: null, pausedAt: null });
  return true;
}

/** Expire unused selections at attempt completion, including rejection and stale-owner exits. */
export function beginHarvestRecoveryFaultAttempt(): (() => HarvestRecoveryFaultAttempt) & {
  readonly identity: HarvestRecoveryFaultAttempt;
} {
  if (!isHarvestRecoveryFaultInjectionEnabled())
    return Object.assign(() => null, { identity: null });
  if (attemptActive) {
    disarmHarvestRecoveryFault(currentAttempt);
    currentAttempt = Symbol('harvest QA generation');
  }
  // A selection armed while idle already belongs to this prospective attempt.
  const attempt = currentAttempt;
  attemptActive = true;
  return Object.assign(
    () => {
      if (currentAttempt !== attempt) return null;
      disarmHarvestRecoveryFault(attempt);
      attemptActive = false;
      currentAttempt = Symbol('harvest QA generation');
      return currentAttempt;
    },
    { identity: attempt },
  );
}

export async function runHarvestRecoveryFaultCheckpoint(
  point: HarvestRecoveryFaultPoint,
  onPause?: () => void,
  attempt = captureHarvestRecoveryFaultAttempt(),
): Promise<void> {
  if (!isHarvestRecoveryFaultInjectionEnabled() || !ownsFault(attempt)) return;
  if (snapshot.armed?.kind !== 'checkpoint' || snapshot.armed.point !== point) return;

  pauseOwner = attempt;
  const paused = new Promise<void>((resolve) => {
    releasePause = resolve;
  });
  publish({ armed: null, pausedAt: point });
  onPause?.();
  await paused;
  releasePause = null;
  pauseOwner = null;
  publish({ armed: null, pausedAt: null });
}

/** The retained pause owner may release even after supersession; current ownership is insufficient. */
export function releaseHarvestRecoveryCheckpoint(attempt: HarvestRecoveryFaultAttempt): boolean {
  if (
    !isHarvestRecoveryFaultInjectionEnabled() ||
    attempt === null ||
    attempt !== pauseOwner ||
    !releasePause
  )
    return false;
  const release = releasePause;
  releasePause = null;
  release();
  return true;
}

export function consumeHarvestRecoveryStorageFailure(
  operation: HarvestRecoveryStorageOperation,
  attempt = captureHarvestRecoveryFaultAttempt(),
): boolean {
  if (
    !isHarvestRecoveryFaultInjectionEnabled() ||
    !ownsFault(attempt) ||
    snapshot.armed?.kind !== 'storage_failure' ||
    snapshot.armed.operation !== operation
  ) {
    return false;
  }
  publish({ armed: null, pausedAt: null });
  return true;
}

export function consumeHarvestRecoveryCorruptionFault(
  attempt = captureHarvestRecoveryFaultAttempt(),
): boolean {
  if (
    !isHarvestRecoveryFaultInjectionEnabled() ||
    !ownsFault(attempt) ||
    snapshot.armed?.kind !== 'corrupt_empty_record'
  ) {
    return false;
  }
  publish({ armed: null, pausedAt: null });
  return true;
}
