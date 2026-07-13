# Mobile (`apps/mobile`)

Expo (SDK 51) + React Native + TypeScript app for Agrovix AgOS.
Routing uses **Expo Router** (file-based, typed).

## Start

```bash
pnpm --filter @agrovix/mobile dev
# scan the QR code with Expo Go, or press "i" / "a" for simulators
```

## Structure

```
app/                          # expo-router file-based routes
├── _layout.tsx               # root stack, AuthProvider, safe area
├── index.tsx                 # Splash — routes to /login or /dashboard
├── login.tsx
├── register.tsx
└── dashboard.tsx
src/
└── lib/
    ├── api.ts                # fetch client (Authorization: Bearer)
    ├── auth-context.tsx      # AuthProvider + useAuth hook
    └── secure-storage.ts     # Expo SecureStore wrappers (Keychain / EncryptedSharedPreferences)
```

## Security

Tokens are stored via **Expo SecureStore** on iOS/Android and
`sessionStorage` on web. `localStorage` is never used.
