const IS_DEV = process.env.APP_VARIANT === "development";

// ATS exception for dev HTTP connections (production should use HTTPS)
const getAtsException = () => {
  // Explicit API URL - check if HTTP
  const apiUrl = process.env.EXPO_PUBLIC_API_URL;
  if (apiUrl) {
    try {
      const url = new URL(apiUrl);
      if (url.protocol === "http:") {
        return url.hostname;
      }
    } catch {
      // Invalid URL, skip
    }
    return null;
  }
  // Dev mode - use packager hostname
  return process.env.REACT_NATIVE_PACKAGER_HOSTNAME ?? null;
};

const atsHost = getAtsException();
const iosInfoPlist = atsHost
  ? {
      NSAppTransportSecurity: {
        NSExceptionDomains: {
          [atsHost]: {
            NSExceptionAllowsInsecureHTTPLoads: true,
            NSIncludesSubdomains: false,
          },
        },
      },
    }
  : undefined;

export default {
  expo: {
    name: IS_DEV ? "Vuhlp (Dev)" : "Vuhlp",
    slug: "vuhlp-mobile",
    version: "0.1.0",
    orientation: "default",
    scheme: IS_DEV ? "vuhlp-dev" : "vuhlp",
    userInterfaceStyle: "automatic",
    newArchEnabled: true,
    ios: {
      supportsTablet: true,
      bundleIdentifier: IS_DEV ? "com.vuhlp.mobile.dev" : "com.vuhlp.mobile",
      deploymentTarget: "17.0",
      appleTeamId: "8YW4D4C6CW",
      ...(iosInfoPlist ? { infoPlist: iosInfoPlist } : {}),
    },
    android: {
      package: IS_DEV ? "com.vuhlp.mobile.dev" : "com.vuhlp.mobile",
    },
    plugins: ["expo-router", "expo-asset"],
    experiments: {
      typedRoutes: true,
    },
  },
};
