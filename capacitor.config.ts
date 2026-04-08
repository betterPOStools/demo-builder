import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.valuesystems.demobuilder',
  appName: 'Demo Builder',
  webDir: 'out',
  server: {
    url: 'https://demo-builder-seven.vercel.app',
    cleartext: false,
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
