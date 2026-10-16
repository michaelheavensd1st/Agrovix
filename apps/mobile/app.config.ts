import type { ExpoConfig } from 'expo/config';
import baseAppConfig from './app.json';

const APPROVED_QA_API_HOSTS: readonly string[] = [];

type AppConfigEnvironment = Record<string, string | undefined>;

export function validateQaApiUrl(
  value: string | undefined,
  approvedHosts: readonly string[] = APPROVED_QA_API_HOSTS,
): string {
  if (!value) throw new Error('A separately approved QA API URL is required.');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The QA API URL must be a valid absolute URL.');
  }

  const hostname = url.hostname.toLowerCase();
  const allowedHosts = new Set(approvedHosts.map((host) => host.toLowerCase()));
  if (
    url.protocol !== 'https:' ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '[::1]' ||
    /^127\./.test(hostname) ||
    (url.port !== '' && url.port !== '443') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/api(?:\/|$)/.test(url.pathname) ||
    !allowedHosts.has(hostname)
  ) {
    throw new Error('The QA API URL is not an approved HTTPS QA endpoint.');
  }

  return url.toString().replace(/\/$/, '');
}

export function createAppConfig(
  baseConfig: ExpoConfig,
  environment: AppConfigEnvironment,
  approvedHosts: readonly string[] = APPROVED_QA_API_HOSTS,
): ExpoConfig {
  const variant = environment.APP_VARIANT;
  const faultInjectionFlag = environment.EXPO_PUBLIC_FD_QA_FAULT_INJECTION;

  if (variant === undefined) {
    if (faultInjectionFlag === 'true') {
      throw new Error('The QA fault-injection flag is only valid for the fdqa variant.');
    }
    return baseConfig;
  }
  if (variant !== 'fdqa') throw new Error(`Unsupported app variant: ${variant}.`);
  if (faultInjectionFlag !== 'true') {
    throw new Error('The fdqa variant requires its build-time fault-injection build flag.');
  }

  const qaApiUrl = validateQaApiUrl(environment.FD_QA_API_URL, approvedHosts);
  if (environment.EXPO_PUBLIC_API_URL !== undefined) {
    const publicApiUrl = validateQaApiUrl(environment.EXPO_PUBLIC_API_URL, approvedHosts);
    if (publicApiUrl !== qaApiUrl) {
      throw new Error('EXPO_PUBLIC_API_URL must match the approved QA API URL.');
    }
  }

  return {
    ...baseConfig,
    name: 'Agrovix AgOS F-D QA',
    scheme: 'agrovix-fdqa',
    ios: {
      ...baseConfig.ios,
      bundleIdentifier: 'com.agrovix.agos.fdqa',
    },
    android: {
      ...baseConfig.android,
      package: 'com.agrovix.agos.fdqa',
    },
    extra: {
      ...baseConfig.extra,
      apiUrl: qaApiUrl,
      appVariant: 'fdqa',
      fdQaFaultInjection: true,
    },
  };
}

export default (): ExpoConfig => createAppConfig(baseAppConfig.expo as ExpoConfig, process.env);
