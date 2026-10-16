import type { ExpoConfig } from 'expo/config';
import baseAppConfig from './app.json';
import easConfig from './eas.json';
import { createAppConfig } from './app.config';

const productionConfig = baseAppConfig.expo as ExpoConfig;
const approvedHost = 'fd-qa-api.example.test';
const qaEnvironment = {
  APP_VARIANT: 'fdqa',
  EXPO_PUBLIC_FD_QA_FAULT_INJECTION: 'true',
  FD_QA_API_URL: `https://${approvedHost}/api`,
};

describe('F-D app configuration', () => {
  test('keeps the production app configuration unchanged by default', () => {
    expect(createAppConfig(productionConfig, {})).toEqual(productionConfig);
  });

  test('requires the QA build-time flag before selecting the QA identity', () => {
    expect(() =>
      createAppConfig(productionConfig, { APP_VARIANT: 'fdqa' }, [approvedHost]),
    ).toThrow(/fault-injection build flag/i);
  });

  test('selects an isolated QA identity only with an approved API host', () => {
    const config = createAppConfig(productionConfig, qaEnvironment, [approvedHost]);

    expect(config).toMatchObject({
      name: 'Agrovix AgOS F-D QA',
      scheme: 'agrovix-fdqa',
      ios: { bundleIdentifier: 'com.agrovix.agos.fdqa' },
      android: { package: 'com.agrovix.agos.fdqa' },
      extra: {
        apiUrl: qaEnvironment.FD_QA_API_URL,
        appVariant: 'fdqa',
        fdQaFaultInjection: true,
      },
    });
  });

  test.each(['production', 'unknown'])('rejects unsupported variant %s', (variant) => {
    expect(() =>
      createAppConfig(productionConfig, { ...qaEnvironment, APP_VARIANT: variant }, [approvedHost]),
    ).toThrow(/unsupported app variant/i);
  });

  test.each([
    undefined,
    '',
    'not a url',
    'https://localhost/api',
    'https://127.0.0.1/api',
    'https://[::1]/api',
    'http://fd-qa-api.example.test/api',
    'https://fd-qa-api.example.test.evil.test/api',
    'https://user:password@fd-qa-api.example.test/api',
    'https://fd-qa-api.example.test/api?target=production',
    'https://agrovix-api-amused-ambition-release-uat.up.railway.app/api',
  ])('rejects unsafe or unapproved QA API URL %s', (url) => {
    expect(() =>
      createAppConfig(productionConfig, { ...qaEnvironment, FD_QA_API_URL: url }, [approvedHost]),
    ).toThrow(/QA API URL/i);
  });

  test('fails closed with the actual empty approval list', () => {
    expect(() => createAppConfig(productionConfig, qaEnvironment)).toThrow(/QA API URL/i);
  });

  test('rejects a conflicting public API URL before Expo can bundle it', () => {
    expect(() =>
      createAppConfig(
        productionConfig,
        {
          ...qaEnvironment,
          EXPO_PUBLIC_API_URL: 'https://production.example.test/api',
        },
        [approvedHost],
      ),
    ).toThrow(/QA API URL/i);
  });

  test('rejects production builds when the QA harness flag is set', () => {
    expect(() =>
      createAppConfig(productionConfig, {
        EXPO_PUBLIC_FD_QA_FAULT_INJECTION: 'true',
      }),
    ).toThrow(/only valid for the fdqa variant/i);
  });

  test.each([
    ['fd-qa-android', 'ubuntu-26.04-jdk-17-ndk-r27b-sdk-57'],
    ['fd-qa-ios', 'macos-tahoe-26.5-xcode-26.6'],
    ['fd-qa-ios-simulator', 'macos-tahoe-26.5-xcode-26.6'],
  ])('pins %s to the SDK 57 image and isolated QA build inputs', (profile, image) => {
    const config = easConfig.build[profile as keyof typeof easConfig.build] as {
      env?: Record<string, string>;
      node?: string;
      pnpm?: string;
      android?: { image?: string; buildType?: string };
      ios?: { image?: string; simulator?: boolean };
    };

    expect(config.env).toMatchObject({
      APP_VARIANT: 'fdqa',
      EXPO_PUBLIC_FD_QA_FAULT_INJECTION: 'true',
    });
    expect(config.node).toBe('22.23.1');
    expect(config.pnpm).toBe('9.12.0');
    expect(config.android?.image ?? config.ios?.image).toBe(image);
    expect(config.env).not.toHaveProperty('FD_QA_API_URL');
    expect(config.env).not.toHaveProperty('EXPO_PUBLIC_API_URL');
  });

  test('retains the legacy validation profile required by the existing API test', () => {
    expect(easConfig.build['sdk56-validation']).toBeDefined();
  });
});
