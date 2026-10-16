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
    const callback = jest.fn();
    expect(armHarvestRecoveryFault({ kind: 'checkpoint', point: 'after_posting' })).toBe(true);

    await runHarvestRecoveryFaultCheckpoint('after_prepared', callback);
    expect(callback).not.toHaveBeenCalled();
    expect(getHarvestRecoveryFaultSnapshot().armed).toEqual({
      kind: 'checkpoint',
      point: 'after_posting',
    });

    const pause = runHarvestRecoveryFaultCheckpoint('after_posting', callback);
    expect(releaseHarvestRecoveryCheckpoint()).toBe(true);
    await pause;
    expect(callback).toHaveBeenCalledTimes(1);
    await runHarvestRecoveryFaultCheckpoint('after_posting', callback);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  test('pauses at the armed boundary and resumes only after explicit release', async () => {
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
    expect(releaseHarvestRecoveryCheckpoint()).toBe(true);
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
});
