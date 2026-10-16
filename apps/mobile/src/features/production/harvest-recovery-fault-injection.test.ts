const mockExpoConfig = {
  ios: { bundleIdentifier: 'com.agrovix.agos.fdqa' },
  android: { package: 'com.agrovix.agos.fdqa' },
  extra: {
    appVariant: 'fdqa',
    fdQaFaultInjection: true,
  },
};

jest.mock('expo-constants', () => ({
  get expoConfig() {
    return mockExpoConfig;
  },
}));

import {
  armHarvestRecoveryFault,
  beginHarvestRecoveryFaultAttempt,
  captureHarvestRecoveryFaultAttempt,
  disarmHarvestRecoveryFault,
  consumeHarvestRecoveryStorageFailure,
  consumeHarvestRecoveryCorruptionFault,
  getHarvestRecoveryFaultSnapshot,
  isHarvestRecoveryFaultInjectionEnabled,
  releaseHarvestRecoveryCheckpoint,
  runHarvestRecoveryFaultCheckpoint,
  subscribeHarvestRecoveryFaults,
} from './harvest-recovery-fault-injection';

describe('QA HARVEST recovery fault injection', () => {
  const originalFlag = process.env.EXPO_PUBLIC_FD_QA_FAULT_INJECTION;

  beforeEach(() => {
    process.env.EXPO_PUBLIC_FD_QA_FAULT_INJECTION = 'true';
  });

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.EXPO_PUBLIC_FD_QA_FAULT_INJECTION;
    } else {
      process.env.EXPO_PUBLIC_FD_QA_FAULT_INJECTION = originalFlag;
    }
  });

  test('is disabled without the build-time QA flag or QA application identity', () => {
    delete process.env.EXPO_PUBLIC_FD_QA_FAULT_INJECTION;
    expect(isHarvestRecoveryFaultInjectionEnabled()).toBe(false);

    process.env.EXPO_PUBLIC_FD_QA_FAULT_INJECTION = 'true';
    mockExpoConfig.extra.appVariant = 'production';
    expect(isHarvestRecoveryFaultInjectionEnabled()).toBe(false);
    mockExpoConfig.extra.appVariant = 'fdqa';
  });

  test.each(['ios', 'android', 'extra'] as const)(
    'rejects a mismatched %s identity despite the public build flag',
    (field) => {
      if (field === 'ios') {
        mockExpoConfig.ios.bundleIdentifier = 'com.agrovix.agos';
        expect(armHarvestRecoveryFault({ kind: 'storage_failure', operation: 'write' })).toBe(
          false,
        );
        mockExpoConfig.ios.bundleIdentifier = 'com.agrovix.agos.fdqa';
      } else if (field === 'android') {
        mockExpoConfig.android.package = 'com.agrovix.agos';
        expect(armHarvestRecoveryFault({ kind: 'storage_failure', operation: 'write' })).toBe(
          false,
        );
        mockExpoConfig.android.package = 'com.agrovix.agos.fdqa';
      } else {
        mockExpoConfig.extra.fdQaFaultInjection = false;
        expect(armHarvestRecoveryFault({ kind: 'storage_failure', operation: 'write' })).toBe(
          false,
        );
        mockExpoConfig.extra.fdQaFaultInjection = true;
      }
    },
  );

  test('unarmed checkpoints are inert', async () => {
    const callback = jest.fn();
    await runHarvestRecoveryFaultCheckpoint('after_prepared', callback);
    expect(callback).not.toHaveBeenCalled();
    expect(getHarvestRecoveryFaultSnapshot()).toEqual({ armed: null, pausedAt: null });
  });

  test('fires only the matching checkpoint and consumes it once', async () => {
    const checkpointOwner = captureHarvestRecoveryFaultAttempt();
    const callback = jest.fn();
    expect(armHarvestRecoveryFault({ kind: 'checkpoint', point: 'after_posting' })).toBe(true);

    await runHarvestRecoveryFaultCheckpoint('after_prepared', callback);
    expect(callback).not.toHaveBeenCalled();
    expect(getHarvestRecoveryFaultSnapshot().armed).toEqual({
      kind: 'checkpoint',
      point: 'after_posting',
    });

    const pause = runHarvestRecoveryFaultCheckpoint('after_posting', callback);
    expect(releaseHarvestRecoveryCheckpoint(checkpointOwner)).toBe(true);
    await pause;
    expect(callback).toHaveBeenCalledTimes(1);
    await runHarvestRecoveryFaultCheckpoint('after_posting', callback);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  test('pauses at the armed boundary and resumes only after explicit release', async () => {
    const checkpointOwner = captureHarvestRecoveryFaultAttempt();
    expect(armHarvestRecoveryFault({ kind: 'checkpoint', point: 'after_reconciled' })).toBe(true);
    const seen: string[] = [];
    const subscription = subscribeHarvestRecoveryFaults(() => {
      seen.push(getHarvestRecoveryFaultSnapshot().pausedAt ?? 'released');
    });
    let continued = false;
    const checkpoint = runHarvestRecoveryFaultCheckpoint('after_reconciled').then(() => {
      continued = true;
    });

    await Promise.resolve();
    expect(getHarvestRecoveryFaultSnapshot().pausedAt).toBe('after_reconciled');
    expect(continued).toBe(false);
    expect(releaseHarvestRecoveryCheckpoint(checkpointOwner)).toBe(true);
    await checkpoint;
    subscription();
    expect(continued).toBe(true);
    expect(seen).toContain('after_reconciled');
  });

  test('storage failures and corruption are one-shot and operation-specific', () => {
    expect(
      armHarvestRecoveryFault({ kind: 'storage_failure', operation: 'verification_read' }),
    ).toBe(true);
    expect(consumeHarvestRecoveryStorageFailure('read')).toBe(false);
    expect(consumeHarvestRecoveryStorageFailure('verification_read')).toBe(true);
    expect(consumeHarvestRecoveryStorageFailure('verification_read')).toBe(false);

    expect(armHarvestRecoveryFault({ kind: 'corrupt_empty_record' })).toBe(true);
    expect(consumeHarvestRecoveryCorruptionFault()).toBe(true);
    expect(consumeHarvestRecoveryCorruptionFault()).toBe(false);
  });

  test('rejects overlapping controls and cannot arm in a production build', () => {
    expect(armHarvestRecoveryFault({ kind: 'storage_failure', operation: 'delete' })).toBe(true);
    expect(armHarvestRecoveryFault({ kind: 'corrupt_empty_record' })).toBe(false);
    expect(consumeHarvestRecoveryStorageFailure('delete')).toBe(true);

    delete process.env.EXPO_PUBLIC_FD_QA_FAULT_INJECTION;
    expect(armHarvestRecoveryFault({ kind: 'corrupt_empty_record' })).toBe(false);
    expect(getHarvestRecoveryFaultSnapshot().armed).toBeNull();
  });
  test.each([
    { kind: 'checkpoint', point: 'after_accepted' },
    { kind: 'storage_failure', operation: 'delete' },
    { kind: 'corrupt_empty_record' },
  ] as const)('explicitly cancels unused $kind and permits another selection', (fault) => {
    expect(armHarvestRecoveryFault(fault)).toBe(true);
    expect(releaseHarvestRecoveryCheckpoint(captureHarvestRecoveryFaultAttempt())).toBe(false);
    expect(disarmHarvestRecoveryFault()).toBe(true);
    expect(getHarvestRecoveryFaultSnapshot()).toEqual({ armed: null, pausedAt: null });
    expect(disarmHarvestRecoveryFault()).toBe(false);
    expect(armHarvestRecoveryFault({ kind: 'storage_failure', operation: 'read' })).toBe(true);
    expect(consumeHarvestRecoveryStorageFailure('read')).toBe(true);
  });

  test('disarming or completing an attempt cannot release its pause or allow overlapping faults', async () => {
    const finish = beginHarvestRecoveryFaultAttempt();
    expect(armHarvestRecoveryFault({ kind: 'checkpoint', point: 'after_posting' })).toBe(true);
    let continued = false;
    const pause = runHarvestRecoveryFaultCheckpoint('after_posting').then(() => {
      continued = true;
    });
    try {
      finish();
      expect(disarmHarvestRecoveryFault()).toBe(false);
      expect(armHarvestRecoveryFault({ kind: 'storage_failure', operation: 'read' })).toBe(false);
      await Promise.resolve();
      expect(continued).toBe(false);
      expect(getHarvestRecoveryFaultSnapshot().pausedAt).toBe('after_posting');
    } finally {
      releaseHarvestRecoveryCheckpoint(finish.identity);
      await pause;
    }
    expect(continued).toBe(true);
  });

  test('attempt completion expires an unused fault and an older completion cannot cancel a newer selection', () => {
    const finishOld = beginHarvestRecoveryFaultAttempt();
    expect(armHarvestRecoveryFault({ kind: 'checkpoint', point: 'after_accepted' })).toBe(true);
    expect(disarmHarvestRecoveryFault()).toBe(true);
    const finishNew = beginHarvestRecoveryFaultAttempt();
    const fault = { kind: 'storage_failure', operation: 'delete' } as const;
    expect(armHarvestRecoveryFault(fault)).toBe(true);
    finishOld();
    expect(getHarvestRecoveryFaultSnapshot().armed).toEqual(fault);
    finishNew();
    expect(getHarvestRecoveryFaultSnapshot().armed).toBeNull();
    expect(consumeHarvestRecoveryStorageFailure('delete')).toBe(false);
    expect(armHarvestRecoveryFault({ kind: 'storage_failure', operation: 'read' })).toBe(true);
    finishNew(); // completing twice must not clear a deliberate later selection
    expect(consumeHarvestRecoveryStorageFailure('read')).toBe(true);
  });

  test('a completed attempt also cancels a newly selected but unused fault within that attempt', () => {
    const finish = beginHarvestRecoveryFaultAttempt();
    expect(armHarvestRecoveryFault({ kind: 'storage_failure', operation: 'write' })).toBe(true);
    expect(consumeHarvestRecoveryStorageFailure('write')).toBe(true);
    expect(armHarvestRecoveryFault({ kind: 'checkpoint', point: 'after_accepted' })).toBe(true);
    finish();
    expect(getHarvestRecoveryFaultSnapshot().armed).toBeNull();
  });

  test('production cannot arm or disarm controls or establish an active QA attempt', () => {
    delete process.env.EXPO_PUBLIC_FD_QA_FAULT_INJECTION;
    const finish = beginHarvestRecoveryFaultAttempt();
    expect(armHarvestRecoveryFault({ kind: 'checkpoint', point: 'after_posting' })).toBe(false);
    expect(disarmHarvestRecoveryFault()).toBe(false);
    finish();
    expect(getHarvestRecoveryFaultSnapshot()).toEqual({ armed: null, pausedAt: null });
  });

  test('a replacement attempt cancels the unused selection belonging to a pending old attempt', () => {
    const finishOld = beginHarvestRecoveryFaultAttempt();
    expect(armHarvestRecoveryFault({ kind: 'checkpoint', point: 'after_accepted' })).toBe(true);
    const finishNew = beginHarvestRecoveryFaultAttempt();
    expect(getHarvestRecoveryFaultSnapshot().armed).toBeNull();
    expect(armHarvestRecoveryFault({ kind: 'storage_failure', operation: 'write' })).toBe(true);
    finishOld();
    expect(consumeHarvestRecoveryStorageFailure('write')).toBe(true);
    finishNew();
  });
  test('superseded identities cannot arm, consume or disarm a newer generation', () => {
    const finishA = beginHarvestRecoveryFaultAttempt();
    const finishB = beginHarvestRecoveryFaultAttempt();
    const fault = { kind: 'storage_failure', operation: 'write' } as const;
    expect(armHarvestRecoveryFault(fault, finishA.identity)).toBe(false);
    expect(armHarvestRecoveryFault(fault, finishB.identity)).toBe(true);
    expect(consumeHarvestRecoveryStorageFailure('write', finishA.identity)).toBe(false);
    expect(disarmHarvestRecoveryFault(finishA.identity)).toBe(false);
    finishA();
    expect(getHarvestRecoveryFaultSnapshot()).toEqual({ armed: fault, pausedAt: null });
    expect(consumeHarvestRecoveryStorageFailure('write', finishB.identity)).toBe(true);
    expect(consumeHarvestRecoveryStorageFailure('write', finishB.identity)).toBe(false);
    finishB();
  });

  test('a completed generation cannot consume a later idle selection', () => {
    const finishA = beginHarvestRecoveryFaultAttempt();
    finishA();
    expect(armHarvestRecoveryFault({ kind: 'corrupt_empty_record' })).toBe(true);
    expect(consumeHarvestRecoveryCorruptionFault(finishA.identity)).toBe(false);
    expect(disarmHarvestRecoveryFault(finishA.identity)).toBe(false);
    expect(consumeHarvestRecoveryCorruptionFault()).toBe(true);
  });
  test('a superseding generation cannot release an older pause, but its retained owner still can', async () => {
    const finishA = beginHarvestRecoveryFaultAttempt();
    expect(
      armHarvestRecoveryFault({ kind: 'checkpoint', point: 'after_prepared' }, finishA.identity),
    ).toBe(true);
    let resumed = false;
    const pause = runHarvestRecoveryFaultCheckpoint(
      'after_prepared',
      undefined,
      finishA.identity,
    ).then(() => {
      resumed = true;
    });
    const finishB = beginHarvestRecoveryFaultAttempt();
    try {
      expect(releaseHarvestRecoveryCheckpoint(finishB.identity)).toBe(false);
      expect(disarmHarvestRecoveryFault(finishA.identity)).toBe(false);
      await Promise.resolve();
      expect(resumed).toBe(false);
      expect(releaseHarvestRecoveryCheckpoint(finishA.identity)).toBe(true);
      expect(releaseHarvestRecoveryCheckpoint(finishA.identity)).toBe(false);
      await pause;
      expect(resumed).toBe(true);
    } finally {
      releaseHarvestRecoveryCheckpoint(finishA.identity);
      await pause;
      finishA();
      finishB();
    }
  });

  test('ownerless and production-disabled release requests fail closed without resolving a pause', async () => {
    const finish = beginHarvestRecoveryFaultAttempt();
    expect(
      armHarvestRecoveryFault({ kind: 'checkpoint', point: 'after_prepared' }, finish.identity),
    ).toBe(true);
    let resumed = false;
    const pause = runHarvestRecoveryFaultCheckpoint(
      'after_prepared',
      undefined,
      finish.identity,
    ).then(() => {
      resumed = true;
    });
    try {
      expect(Reflect.apply(releaseHarvestRecoveryCheckpoint, undefined, [])).toBe(false);
      expect(releaseHarvestRecoveryCheckpoint(null)).toBe(false);
      delete process.env.EXPO_PUBLIC_FD_QA_FAULT_INJECTION;
      expect(releaseHarvestRecoveryCheckpoint(finish.identity)).toBe(false);
      await Promise.resolve();
      expect(resumed).toBe(false);
      expect(getHarvestRecoveryFaultSnapshot().pausedAt).toBe('after_prepared');
    } finally {
      process.env.EXPO_PUBLIC_FD_QA_FAULT_INJECTION = 'true';
      releaseHarvestRecoveryCheckpoint(finish.identity);
      await pause;
      finish();
    }
  });
});
