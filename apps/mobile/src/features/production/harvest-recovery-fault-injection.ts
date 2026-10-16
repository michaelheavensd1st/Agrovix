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
let releasePause: (() => void) | null = null;

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

export function armHarvestRecoveryFault(fault: HarvestRecoveryFault): boolean {
  if (!isHarvestRecoveryFaultInjectionEnabled() || snapshot.armed || snapshot.pausedAt) {
    return false;
  }
  publish({ armed: fault, pausedAt: null });
  return true;
}

export async function runHarvestRecoveryFaultCheckpoint(
  point: HarvestRecoveryFaultPoint,
  onPause?: () => void,
): Promise<void> {
  if (!isHarvestRecoveryFaultInjectionEnabled()) return;
  if (snapshot.armed?.kind !== 'checkpoint' || snapshot.armed.point !== point) return;

  const paused = new Promise<void>((resolve) => {
    releasePause = resolve;
  });
  publish({ armed: null, pausedAt: point });
  onPause?.();
  await paused;
  releasePause = null;
  publish({ armed: null, pausedAt: null });
}

export function releaseHarvestRecoveryCheckpoint(): boolean {
  if (!releasePause) return false;
  releasePause();
  return true;
}

export function consumeHarvestRecoveryStorageFailure(
  operation: HarvestRecoveryStorageOperation,
): boolean {
  if (
    !isHarvestRecoveryFaultInjectionEnabled() ||
    snapshot.armed?.kind !== 'storage_failure' ||
    snapshot.armed.operation !== operation
  ) {
    return false;
  }
  publish({ armed: null, pausedAt: null });
  return true;
}

export function consumeHarvestRecoveryCorruptionFault(): boolean {
  if (
    !isHarvestRecoveryFaultInjectionEnabled() ||
    snapshot.armed?.kind !== 'corrupt_empty_record'
  ) {
    return false;
  }
  publish({ armed: null, pausedAt: null });
  return true;
}
