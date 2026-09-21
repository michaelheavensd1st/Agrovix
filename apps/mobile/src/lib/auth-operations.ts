import { clearTokens, getAccessToken, getRefreshToken, setTokens } from './secure-storage';

export interface AuthOperation {
  readonly epoch: number;
}

export interface CredentialPair {
  accessToken: string;
  refreshToken: string;
}

let currentEpoch = 0;
let credentialMutationQueue: Promise<void> = Promise.resolve();

export class SingleFlight {
  private pending: Promise<void> | null = null;

  run(operation: () => Promise<void>): Promise<void> {
    if (this.pending) return this.pending;
    const pending = operation().finally(() => {
      if (this.pending === pending) this.pending = null;
    });
    this.pending = pending;
    return pending;
  }
}

export class AuthOperationOwner {
  private operation = beginAuthOperation();

  begin(): AuthOperation {
    this.operation = beginAuthOperation();
    return this.operation;
  }

  invalidate(): void {
    if (ownsAuthOperation(this.operation)) beginAuthOperation();
  }
}

function withCredentialMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = credentialMutationQueue.then(operation, operation);
  credentialMutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function beginAuthOperation(): AuthOperation {
  currentEpoch += 1;
  return { epoch: currentEpoch };
}

export function currentAuthOperation(): AuthOperation {
  return { epoch: currentEpoch };
}

export function ownsAuthOperation(operation: AuthOperation): boolean {
  return operation.epoch === currentEpoch;
}

export async function readCredentialPair(): Promise<CredentialPair | null> {
  const [accessToken, refreshToken] = await Promise.all([getAccessToken(), getRefreshToken()]);
  if (!accessToken?.trim() || !refreshToken?.trim()) return null;
  return { accessToken, refreshToken };
}

export function replaceCredentialPair(
  operation: AuthOperation,
  replacement: CredentialPair,
  expectedRefreshToken?: string,
): Promise<boolean> {
  return withCredentialMutationLock(async () => {
    if (!ownsAuthOperation(operation)) return false;
    if (expectedRefreshToken !== undefined) {
      const current = await readCredentialPair();
      if (!ownsAuthOperation(operation) || current?.refreshToken !== expectedRefreshToken) {
        return false;
      }
    }
    await setTokens(replacement.accessToken, replacement.refreshToken);
    return ownsAuthOperation(operation);
  });
}

export function clearCredentialPair(
  operation: AuthOperation,
  expectedRefreshToken?: string,
): Promise<boolean> {
  return withCredentialMutationLock(async () => {
    if (!ownsAuthOperation(operation)) return false;
    if (expectedRefreshToken !== undefined) {
      const current = await readCredentialPair();
      if (!ownsAuthOperation(operation) || current?.refreshToken !== expectedRefreshToken) {
        return false;
      }
    }
    await clearTokens();
    return ownsAuthOperation(operation);
  });
}
