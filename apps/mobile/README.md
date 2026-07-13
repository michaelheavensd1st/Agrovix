# Mobile (`apps/mobile`)

Expo (SDK 51) + React Native + TypeScript app for Agrovix AgOS.

## Start

```bash
pnpm --filter @agrovix/mobile dev
# scan the QR code with Expo Go, or press "i" / "a" for simulators
```

## Screens (Sprint 0)

| Screen      | File                                 |
| ----------- | ------------------------------------ |
| Splash      | `src/screens/SplashScreen.tsx`       |
| Login       | `src/screens/LoginScreen.tsx`        |
| Register    | `src/screens/RegisterScreen.tsx`     |
| Dashboard   | `src/screens/DashboardScreen.tsx`    |

Navigation lives in `src/navigation/AppNavigator.tsx` and uses React
Navigation's native stack.
