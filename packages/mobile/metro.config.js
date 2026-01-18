const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Enable pnpm workspaces
config.watchFolders = [
  `${__dirname}/../../node_modules`,
  `${__dirname}/../contracts`,
];

// Handle workspace symlinks
config.resolver.nodeModulesPaths = [
  `${__dirname}/node_modules`,
  `${__dirname}/../../node_modules`,
];

module.exports = config;
